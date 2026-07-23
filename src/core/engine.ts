/**
 * Shared step-execution engine (F6a) — unifies the per-step loop that
 * `runMultistepTasks` and `runSettled` used to duplicate (ledger debt from
 * F5). `runSteps` owns everything that is bit-identical between the two
 * runners: per-step call collection, batch slicing, dispatch through the
 * concurrency pool (`src/core/pool.ts`), and index-based routing of results
 * back into per-task `StepResult[]` arrays.
 *
 * The ONLY behavior that differs between `run` (fail-fast) and `runSettled`
 * (record-and-continue) is captured in the 3-hook `StepEnginePolicy` each
 * runner builds for itself, closing over its own state (`ts`, and — for
 * `runSettled` only — its `dead`/`deadError` bookkeeping). `runSteps` never
 * sees that state; it just calls the hooks and trusts their return values.
 *
 * What stays OUTSIDE this module (deliberately): the F2 consumption
 * pipeline (`prepareRun`/`resolvePinnedBlock`, `internal.ts`) and the final
 * `finalize()` pass — both runners diverge sharply there (throw vs settle
 * per task) and gain nothing from sharing.
 */

import type { MultistepTask, StepCall, StepResult, RawResult } from './types'
import { runBatchPool } from './pool'

/**
 * The 3 hooks that fully capture `run` vs `runSettled`'s divergence. Each
 * runner builds one instance of this per call, as plain closures over its
 * own local state — see `runMultistepTasks.ts`/`runSettled.ts`.
 */
export interface StepEnginePolicy {
  /**
   * Build one task's calls for `step`.
   *
   * Return `undefined` to skip this task-step entirely (either it's
   * inactive because `step > task.maxStep`, or — `runSettled` only — the
   * task is already dead). Error handling is entirely the policy's
   * business: `run`'s hook lets a throw propagate straight out of
   * `runSteps` (a plain synchronous throw inside this async function's
   * body — fatal, matches pre-F6a behavior exactly); `runSettled`'s hook
   * catches internally, marks the task dead, and returns `undefined`.
   */
  buildStepCalls(taskIndex: number, step: number): StepCall[] | undefined

  /**
   * Execute ONE physical batch of calls. This is the only hook
   * `runBatchPool` actually calls, so it is the only one whose rejection
   * behavior matters for cancellation:
   *   - `run`'s hook is the raw, unwrapped `executor.executeMulticall` call
   *     (plus the length-mismatch guard) — a rejection here is exactly what
   *     triggers fail-fast.
   *   - `runSettled`'s hook catches a transport rejection and *resolves*
   *     with synthesized per-call `kind:'batch'` failures instead; it only
   *     ever rejects for the length-mismatch executor-bug case (which is
   *     deliberately NOT converted into a recorded failure).
   */
  executeBatch(batch: StepCall[]): Promise<RawResult[]>

  /**
   * Consume one task's results for `step`. Same error-handling split as
   * `buildStepCalls`: `run` lets a throw propagate; `runSettled` catches
   * and marks the task dead.
   */
  consumeStepResults(taskIndex: number, step: number, results: StepResult[]): void
}

/** The subset of `BatchOptions` the engine itself needs. */
export interface StepEngineOptions {
  batchSize: number
  maxConcurrentBatches: number
}

/**
 * Drive every step from 1..maxStep: collect calls, slice into batches,
 * dispatch through the concurrency pool, route results back by task index,
 * then hand each task its per-step results via the policy.
 *
 * Throws (aborting all remaining steps) iff the pool reports a cancelled
 * outcome, or `buildStepCalls`/`consumeStepResults` throws — the latter two
 * propagate directly (no pool involvement; they aren't batch executions).
 */
export async function runSteps<TResult>(
  ts: MultistepTask<TResult>[],
  options: StepEngineOptions,
  policy: StepEnginePolicy,
): Promise<void> {
  const maxStep = ts.reduce((max, task) => (task.maxStep > max ? task.maxStep : max), 0)

  for (let step = 1; step <= maxStep; step++) {
    const calls: StepCall[] = []
    const mapping: { taskIndex: number; key: string }[] = []

    for (let taskIndex = 0; taskIndex < ts.length; taskIndex++) {
      const stepCalls = policy.buildStepCalls(taskIndex, step)
      if (stepCalls === undefined) continue
      for (const call of stepCalls) {
        calls.push(call)
        mapping.push({ taskIndex, key: call.key })
      }
    }

    // Pre-allocate a 2D array indexed by taskIndex for O(1) result grouping
    // — same rationale as the pre-F6a code this replaces.
    const perTaskResults: StepResult[][] = Array.from({ length: ts.length }, () => [])

    if (calls.length > 0) {
      const batches: StepCall[][] = []
      for (let batchStart = 0; batchStart < calls.length; batchStart += options.batchSize) {
        batches.push(calls.slice(batchStart, batchStart + options.batchSize))
      }

      const outcome = await runBatchPool(batches, options.maxConcurrentBatches, (batch) =>
        policy.executeBatch(batch),
      )

      if (outcome.outcome === 'cancelled') {
        // Spec (d): in-flight results are discarded — we never look at
        // whatever the pool may have partially collected, and we never
        // reach the consumeStepResults dispatch loop below for this step.
        throw outcome.error
      }

      // Route each batch's results back into the shared perTaskResults
      // arrays, indexed by ORIGINAL batch index (not completion order) —
      // this is what makes routing completion-order-independent.
      let globalIndex = 0
      for (let b = 0; b < batches.length; b++) {
        const batchResults = outcome.results[b]!
        for (let i = 0; i < batchResults.length; i++) {
          const mappingEntry = mapping[globalIndex]
          globalIndex++
          if (!mappingEntry) continue
          const { taskIndex, key } = mappingEntry
          const result = batchResults[i] as RawResult

          const list = perTaskResults[taskIndex]!
          if (result.status === 'success') {
            list.push({ status: 'success', key, value: result.value })
          } else {
            // Forward the SAME error object — never wrap or discard it.
            // exactOptionalPropertyTypes-safe: only include `error` when the
            // RawResult actually carried one.
            list.push({
              status: 'failure',
              key,
              ...('error' in result && result.error !== undefined ? { error: result.error } : {}),
            })
          }
        }
      }
    }

    // Dispatch to every task index — including inactive/dead ones, whose
    // hook is expected to no-op — so consumeStepResults is invoked
    // consistently each step for every task that's still active.
    for (let i = 0; i < ts.length; i++) {
      policy.consumeStepResults(i, step, perTaskResults[i]!)
    }
  }
}
