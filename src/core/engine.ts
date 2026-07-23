/**
 * Shared step-execution engine (F6a) — unifies the per-step loop that
 * `runMultistepTasks` and `runSettled` used to duplicate (ledger debt from
 * F5). `runSteps` owns everything that is bit-identical between the two
 * runners: per-step call collection, batch slicing, dispatch through the
 * concurrency pool (`src/core/pool.ts`), and index-based routing of results
 * back into per-task `StepResult[]` arrays.
 *
 * The ONLY behavior that differs between `run` (fail-fast) and `runSettled`
 * (record-and-continue) is captured in the `StepEnginePolicy` each runner
 * builds for itself, closing over its own state (`ts`, and — for
 * `runSettled` only — its `dead`/`deadError` bookkeeping). `runSteps` never
 * sees that state; it just calls the hooks and trusts their return values.
 * F6b adds one more (optional) hook, `recordTerminal` — see its doc comment
 * below and `src/core/pool.ts`'s "Terminal policy hook" section for the full
 * adaptive-bisection design.
 *
 * What stays OUTSIDE this module (deliberately): the F2 consumption
 * pipeline (`prepareRun`/`resolvePinnedBlock`, `internal.ts`) and the final
 * `finalize()` pass — both runners diverge sharply there (throw vs settle
 * per task) and gain nothing from sharing.
 *
 * ## Within-step, cross-task dedup (F7)
 *
 * Added after call collection, strictly PRE-bisection: the wire list handed
 * to `runBatchPool` (batching/bisection, `src/core/pool.ts`) is the DEDUPED
 * list, never the raw per-task call list. `src/core/dedupe.ts` owns the key
 * computation (`dedupeKeyFor`) — this module owns the grouping and, on the
 * way back, the result FAN-OUT.
 *
 * **Data structure:** `mapping` used to be one `{ taskIndex, key }` entry
 * per WIRE call (1:1, T14-era). It is now one `{ subscribers: { taskIndex,
 * key }[] }` entry per wire call — a 1:N "who receives this wire call's
 * result" list. With `options.dedupe` off (default), every entry's
 * `subscribers` array has exactly one element and the shape degrades to the
 * old 1:1 behavior byte-for-byte (same iteration count, same routing). With
 * it on, a merged group's entry carries one subscriber per (taskIndex, key)
 * that asked for that exact call — every call whose computed key already
 * has a group gets appended to that entry's `subscribers` list INSTEAD of
 * contributing its own slot to the wire list; a call that is ineligible, or
 * whose key computation itself failed (`dedupeKeyFor` returns `undefined`
 * either way — see its doc comment), always gets its own singleton entry,
 * exactly like the "off" case.
 *
 * **Wire-list order:** built by iterating tasks/calls in their original
 * collection order and pushing a NEW wire entry only the first time a given
 * key (or an ineligible/unkeyed call) is seen — so the wire list is "first
 * representative of each group + every ineligible call, in original
 * relative order of first occurrence", per spec. Batching/bisection then
 * operate on exactly that list, with no awareness dedup ever happened.
 *
 * **Fan-out on the way back:** after the pool settles, each wire call's
 * ONE `RawResult` (success or failure — a bisection-terminal synthesized
 * failure from `recordTerminal` is just another `RawResult` by the time it
 * reaches this routing loop, indistinguishable from an ordinary one) is
 * routed to EVERY subscriber in that entry's list, not just one — so a
 * merged group's failure (transport-terminal via bisection, or a plain
 * per-call revert) reaches every task that asked for it, and a success
 * reaches all of them too. Perf: `dedupeKeyFor` is only ever called when
 * `options.dedupe` is true (see the call-collection loop below) — the
 * default path never computes a key at all.
 */

import type { MultistepTask, StepCall, StepResult, RawResult } from './types'
import { runBatchPool } from './pool'
import { dedupeKeyFor } from './dedupe'

/**
 * The hooks that fully capture `run` vs `runSettled`'s divergence — 3 as of
 * F6a, plus the optional `recordTerminal` added by F6b. Each runner builds
 * one instance of this per call, as plain closures over its own local state
 * — see `runMultistepTasks.ts`/`runSettled.ts`.
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
   * behavior matters for cancellation/bisection:
   *   - `run`'s hook is the raw, unwrapped `executor.executeMulticall` call
   *     — a rejection here is exactly what feeds the pool's bisection (F6b)
   *     and, once terminal, its fail-fast cancellation. The length-mismatch
   *     guard now lives in the pool itself (`src/core/pool.ts`), not here —
   *     it applies uniformly to whole batches AND bisected sub-batches.
   *   - `runSettled`'s hook, with adaptive bisection OFF (default), catches
   *     a transport rejection and *resolves* with synthesized per-call
   *     `kind:'batch'` failures instead — this is what makes `runSettled`
   *     never cancel on an ordinary transport failure. With adaptive ON, it
   *     deliberately lets the rejection propagate to the pool instead, so
   *     bisection can split it — the per-call synthesis then happens once,
   *     at the TERMINAL point, via `recordTerminal` below.
   */
  executeBatch(batch: StepCall[]): Promise<RawResult[]>

  /**
   * Consume one task's results for `step`. Same error-handling split as
   * `buildStepCalls`: `run` lets a throw propagate; `runSettled` catches
   * and marks the task dead.
   */
  consumeStepResults(taskIndex: number, step: number, results: StepResult[]): void

  /**
   * Adaptive bisection's terminal hook (F6b) — see
   * `BisectionPolicy.recordTerminal` in `src/core/pool.ts` for the full
   * contract. Present only for `runSettled` (never cancel on a terminal
   * batch failure — synthesize a per-call `kind:'batch'` `DominoCallError`
   * instead). Absent for `run`, whose terminal handling is the pool's plain
   * fail-fast cancellation, unchanged from T14 in shape.
   */
  recordTerminal?(calls: StepCall[], error: unknown): RawResult[]
}

/** The subset of `BatchOptions` the engine itself needs. */
export interface StepEngineOptions {
  batchSize: number
  maxConcurrentBatches: number
  /** F6b — see `BatchOptions.adaptiveBatching`. */
  adaptiveBatching: boolean
  /** F6b — see `BatchOptions.maxBatchAttempts`. Consulted by the pool only
   *  when `adaptiveBatching` is true; otherwise any rejection is terminal
   *  on its first occurrence regardless of this value (T14 behavior). */
  maxBatchAttempts: number
  /** F7 — see `BatchOptions.dedupe`. Gates whether this step's call
   *  collection groups eligible calls before building the wire list — see
   *  the module doc's "Within-step, cross-task dedup" section. `false`
   *  (default) never calls `dedupeKeyFor` at all. */
  dedupe: boolean
}

/** One wire-list entry's "who receives this call's result" list — see the
 *  module doc's "Data structure" section. Exactly one element unless F7
 *  dedup actually merged two or more subscribers into this entry. */
interface WireMappingEntry {
  subscribers: { taskIndex: number; key: string }[]
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
    const mapping: WireMappingEntry[] = []

    // F7 dedup: only allocated (and only ever consulted) when the option is
    // on — dedup key string -> index of that group's entry in `mapping`/
    // `calls`. Left `undefined` on the default path, which is what makes
    // `dedupeKeyFor` provably never run below (see the module doc's "Perf"
    // note).
    const groupIndexByKey = options.dedupe ? new Map<string, number>() : undefined

    for (let taskIndex = 0; taskIndex < ts.length; taskIndex++) {
      const stepCalls = policy.buildStepCalls(taskIndex, step)
      if (stepCalls === undefined) continue
      for (const call of stepCalls) {
        const subscriber = { taskIndex, key: call.key }

        // `dedupeKeyFor` returns `undefined` for BOTH reasons a call must
        // never be merged (ineligible, or keying itself failed) — either
        // way it falls straight through to the "own wire entry" branch
        // below, identically to the dedup-off path.
        const dedupeKey = groupIndexByKey ? dedupeKeyFor(call) : undefined

        if (dedupeKey !== undefined) {
          const existingIndex = groupIndexByKey!.get(dedupeKey)
          if (existingIndex !== undefined) {
            // Already have a representative wire call for this key — this
            // call contributes no new wire-list entry, just another
            // subscriber to the existing one.
            mapping[existingIndex]!.subscribers.push(subscriber)
            continue
          }
          // First call seen for this key — it becomes the group's
          // representative. Record its (about-to-be-pushed) index BEFORE
          // pushing, so it equals `calls.length` at the moment of the push
          // below.
          groupIndexByKey!.set(dedupeKey, calls.length)
        }

        calls.push(call)
        mapping.push({ subscribers: [subscriber] })
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

      const outcome = await runBatchPool(batches, options.maxConcurrentBatches, (batch) => policy.executeBatch(batch), {
        adaptive: options.adaptiveBatching,
        maxBatchAttempts: options.maxBatchAttempts,
        ...(policy.recordTerminal ? { recordTerminal: policy.recordTerminal } : {}),
      })

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
          const result = batchResults[i] as RawResult

          // F7 fan-out: route this ONE wire result to EVERY subscriber —
          // success and failure alike, and regardless of whether the
          // failure came from an ordinary per-call revert or a bisection
          // TERMINAL synthesis (`recordTerminal`, `src/core/pool.ts`): by
          // the time it's a `RawResult` here, both are indistinguishable,
          // so every subscriber of a merged group sees the same outcome. A
          // non-merged call's entry has exactly one subscriber, so this
          // degrades to the pre-F7 single-route behavior identically.
          for (const { taskIndex, key } of mappingEntry.subscribers) {
            const list = perTaskResults[taskIndex]!
            if (result.status === 'success') {
              list.push({ status: 'success', key, value: result.value })
            } else {
              // Forward the SAME error object — never wrap or discard it.
              // exactOptionalPropertyTypes-safe: only include `error` when
              // the RawResult actually carried one.
              list.push({
                status: 'failure',
                key,
                ...('error' in result && result.error !== undefined ? { error: result.error } : {}),
              })
            }
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
