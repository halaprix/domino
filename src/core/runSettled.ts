/**
 * Per-task settlement wrapper around the FSM executor (F5).
 *
 * `run` (`runMultistepTasks`) throws on the first irrecoverable batch failure
 * or the first `finalize()` throw — a single bad task or a single bad batch
 * aborts the whole run. `runSettled` isolates failures instead: every task
 * gets its own `SettledTaskResult`, and one task's failure never prevents
 * its siblings from completing.
 *
 * **Batch-failure isolation (controller decision 3):** when
 * `executor.executeMulticall` REJECTS for a physical batch, `runSettled`
 * does NOT throw. Every call in that batch becomes a `failure` StepResult
 * carrying a fresh, per-call {@link DominoCallError} (`kind: 'batch'`) whose
 * `cause` is the SAME transport error object for every call in the batch —
 * only the wrapping `DominoCallError` instance differs per call. Execution
 * continues: later batches in the same step, and later steps, still run.
 * Tasks whose `finalize()` copes with the resulting failures settle as
 * `fulfilled`.
 *
 * **Dead-task rule (controller ruling — not explicit in the spec text):**
 * if a task's `buildStepCalls()` or `consumeStepResults()` throws, that task
 * is marked dead: no further `buildStepCalls`, `consumeStepResults`, or
 * `finalize` calls are made for it, and it settles as
 * `{ status: 'rejected', error: <thrown value> }`. Sibling tasks are
 * unaffected and continue normally. (The spec is explicit only about
 * `finalize()` throwing → rejected; this extends the same treatment to the
 * other two lifecycle hooks so a broken task can never corrupt or block its
 * siblings' routing.)
 *
 * **Scope note (F5/F2 boundary):** `TaskDiagnostics.optionalFailures` is `[]`
 * for plain `MultistepTask` consumers (no `[DIAGNOSTICS]` channel to read).
 * `defineTask` (T8) tasks carry a live diagnostics object read through the
 * `DIAGNOSTICS` symbol below — see its doc comment. Likewise, the "rejected
 * only when a failed non-optional ref is reachable from the returned shape"
 * rule is a `defineTask`-only refinement; the legacy rule implemented here
 * is simply "rejected iff the task's own code (`buildStepCalls`/
 * `consumeStepResults`/`finalize`) throws".
 */

import type { MultistepTask, StepCall, StepResult, StepExecutor, RawResult, Address } from './types'
import type { BatchOptions } from './runMultistepTasks'
import { DominoCallError } from './errors'

/**
 * Internal-only diagnostics channel (F2). A compiled `defineTask()` output
 * carries `[DIAGNOSTICS]: () => TaskDiagnostics` returning ITS live
 * diagnostics object (mutated as `optional` refs fail during execution).
 * `runSettled` reads it — see the two call sites below — falling back to an
 * empty `TaskDiagnostics` for tasks that don't carry the channel (every
 * legacy `MultistepTask`).
 *
 * Exported so `defineTask.ts` can import it and stamp its compiled tasks,
 * but this symbol is NEVER re-exported from `src/index.ts` — it is not part
 * of the public API surface.
 */
export const DIAGNOSTICS: unique symbol = Symbol('domino.diagnostics')

/** Structural type for a task that carries the internal diagnostics channel. */
export interface DiagnosticsCarrier {
  [DIAGNOSTICS]?: () => TaskDiagnostics
}

/**
 * Per-task diagnostics — always present (never optional), even when empty.
 *
 * `optionalFailures` records `DominoCallError`s for refs marked `optional`
 * that were demoted to `undefined` instead of rejecting the task. Populated
 * only for `defineTask` tasks (T8); always `[]` for legacy `MultistepTask`s.
 */
export interface TaskDiagnostics {
  optionalFailures: Array<{ target?: Address; functionName?: string; error: DominoCallError }>
}

/** Per-task settlement outcome — mirrors `Promise.allSettled`'s shape, plus diagnostics. */
export type SettledTaskResult<T> =
  | { status: 'fulfilled'; value: T; diagnostics: TaskDiagnostics }
  | { status: 'rejected'; error: unknown; diagnostics: TaskDiagnostics }

/**
 * Execute multiple MultistepTasks against a single StepExecutor, settling
 * each task independently instead of rejecting the whole call on the first
 * failure.
 *
 * @param executor - Framework-specific multicall executor (viem, ethers, etc.)
 * @param tasks - Array of MultistepTask instances
 * @param options - Optional batching options (same `BatchOptions` as `run`)
 * @returns One `SettledTaskResult` per input task, same order as input.
 *
 * @remarks
 * `options.batchSize` validation is a programmer error, not a call failure:
 * an invalid `batchSize` makes the returned promise itself reject — it does
 * not produce a settled-but-rejected array. Same for a `StepExecutor` that
 * resolves with the wrong number of results for a batch (an implementation
 * bug in the executor, not a call failure) — see the length-mismatch guard
 * below, which mirrors `run`'s behavior exactly.
 */
export async function runSettled<TResult>(
  executor: StepExecutor,
  tasks: MultistepTask<TResult>[],
  options?: BatchOptions,
): Promise<SettledTaskResult<TResult>[]> {
  // Validation is a programmer error and must throw regardless of whether
  // there happen to be any tasks — checked BEFORE the empty-tasks shortcut
  // so `runSettled(executor, [], { batchSize: 0 })` rejects rather than
  // silently resolving to `[]`.
  const batchSize = options?.batchSize ?? 100
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`batchSize must be a positive integer, got ${batchSize}`)
  }

  if (tasks.length === 0) return []

  const maxStep = tasks.reduce((max, task) => (task.maxStep > max ? task.maxStep : max), 0)

  // Dead-task bookkeeping: once true, no further buildStepCalls/consumeStepResults
  // calls happen for that task index, and finalize() is skipped entirely.
  const dead: boolean[] = new Array(tasks.length).fill(false)
  const deadError: unknown[] = new Array(tasks.length)

  for (let step = 1; step <= maxStep; step++) {
    const calls: StepCall[] = []
    const mapping: { taskIndex: number; key: string }[] = []

    for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
      if (dead[taskIndex]) continue
      const task = tasks[taskIndex]!
      if (step > task.maxStep) continue

      let stepCalls: StepCall[]
      try {
        stepCalls = task.buildStepCalls(step)
      } catch (err) {
        dead[taskIndex] = true
        deadError[taskIndex] = err
        continue
      }

      for (const call of stepCalls) {
        calls.push(call)
        mapping.push({ taskIndex, key: call.key })
      }
    }

    const perTaskResults: StepResult[][] = Array.from({ length: tasks.length }, () => [])

    if (calls.length > 0) {
      for (let batchStart = 0; batchStart < calls.length; batchStart += batchSize) {
        const batch = calls.slice(batchStart, batchStart + batchSize)

        let results: RawResult[]
        try {
          results = await executor.executeMulticall(batch, options?.block)
        } catch (transportError) {
          // Batch-level failure: every call in THIS physical batch fails with
          // its own DominoCallError, all sharing the SAME cause. Do not
          // rethrow — later batches/steps still execute.
          results = batch.map(
            (call): RawResult => ({
              status: 'failure',
              error: new DominoCallError(`Call ${call.key} failed: containing batch rejected`, {
                kind: 'batch',
                cause: transportError,
                target: call.target,
                functionName: call.functionName,
                key: call.key,
              }),
            }),
          )
        }

        // Dev-time guard (same as `run`): an executor that resolved but
        // returned the wrong number of results would silently corrupt
        // routing. This is an executor-implementation bug, not a call
        // failure, so it is NOT converted into a batch StepResult — it
        // aborts `runSettled` entirely, same as an invalid batchSize.
        if (results.length !== batch.length) {
          throw new Error(
            `StepExecutor returned ${results.length} results for ${batch.length} calls — length mismatch`,
          )
        }

        for (let i = 0; i < results.length; i++) {
          const mappingEntry = mapping[batchStart + i]
          if (!mappingEntry) continue
          const { taskIndex, key } = mappingEntry
          const result = results[i] as RawResult

          const list = perTaskResults[taskIndex]!
          if (result.status === 'success') {
            list.push({ status: 'success', key, value: result.value })
          } else {
            // Forward the SAME error object — never wrap or discard it.
            list.push({
              status: 'failure',
              key,
              ...('error' in result && result.error !== undefined ? { error: result.error } : {}),
            })
          }
        }
      }
    }

    for (let i = 0; i < tasks.length; i++) {
      if (dead[i]) continue
      const task = tasks[i]
      if (task && step <= task.maxStep) {
        try {
          task.consumeStepResults(step, perTaskResults[i]!)
        } catch (err) {
          dead[i] = true
          deadError[i] = err
        }
      }
    }
  }

  return tasks.map((task, i): SettledTaskResult<TResult> => {
    // Read the task's OWN live diagnostics if it carries the channel (defineTask,
    // F2); every legacy MultistepTask lacks [DIAGNOSTICS] and falls back to an
    // empty (freshly allocated, never shared) TaskDiagnostics.
    const carrier = task as MultistepTask<TResult> & DiagnosticsCarrier
    const diagnostics = (): TaskDiagnostics => carrier[DIAGNOSTICS]?.() ?? { optionalFailures: [] }
    if (dead[i]) {
      return { status: 'rejected', error: deadError[i], diagnostics: diagnostics() }
    }
    try {
      const value = task.finalize()
      return { status: 'fulfilled', value, diagnostics: diagnostics() }
    } catch (err) {
      return { status: 'rejected', error: err, diagnostics: diagnostics() }
    }
  })
}
