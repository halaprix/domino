/**
 * FSM executor for MultistepTask pipelines.
 *
 * Algorithm:
 * 1. Find maxStep across all tasks.
 * 2. For each step 1..maxStep:
 *    a. Build all calls from all tasks for this step.
 *    b. Batch into one multicall via StepExecutor.
 *    c. Distribute results back to tasks by key.
 * 3. Call finalize() on all tasks and return results.
 *
 * Complexity: O(M) RPC calls where M = maxStep across all tasks.
 * (vs O(N) sequential calls for naive approach)
 */

import type { MultistepTask, StepCall, StepResult, StepExecutor, RawResult, BlockParam } from './types'
import { prepareRun, resolvePinnedBlock } from './internal'

/**
 * Options for runMultistepTasks.
 */
export interface BatchOptions {
  /**
   * Maximum number of calls per multicall batch.
   *
   * Multicall3 aggregate3 has a per-call gas limit. When a single step has
   * more than this many calls, it is split into sequential batches.
   * Default: 100. Must be a positive integer — anything else throws.
   */
  batchSize?: number

  /** Block to query at (defaults to 'latest'). Same block used for ALL steps. */
  block?: BlockParam
}

/**
 * Execute multiple MultistepTasks against a single StepExecutor.
 *
 * @param executor - Framework-specific multicall executor (viem, ethers, etc.)
 * @param tasks - Array of MultistepTask instances
 * @param options - Optional batching options
 * @returns Array of finalized results in same order as input tasks
 *
 * @remarks
 * **Mixed step-counts:** all tasks finalize together after the global maxStep
 * completes. A task with `maxStep: 1` mixed with tasks that have `maxStep: 2`
 * contributes no calls in step 2, but its result is still not returned until
 * all steps finish. This is intentional — batching both groups at step 1 saves
 * one RPC round-trip compared to two separate calls.
 *
 * If you genuinely need the shorter tasks' results before the longer ones finish,
 * run them in separate `runMultistepTasks` calls (costs one extra round-trip):
 * ```ts
 * const [erc20s, vaults] = await Promise.all([
 *   runMultistepTasks(executor, erc20Tasks),   // 1 round-trip
 *   runMultistepTasks(executor, erc4626Tasks), // 2 round-trips
 * ])
 * // Total: 2 round-trips instead of 2 (same!) — but results arrive separately
 * ```
 */
export async function runMultistepTasks<TResult>(
  executor: StepExecutor,
  tasks: MultistepTask<TResult>[],
  options?: BatchOptions,
): Promise<TResult[]> {
  // Empty-tasks shortcut runs BEFORE the F2 consumption pipeline — this is
  // 1.0 behavior (an invalid `batchSize` with zero tasks silently resolves
  // to `[]` rather than throwing) and must not change; see `runSettled`'s
  // deliberately different ordering (it validates first) for contrast.
  if (tasks.length === 0) return []

  // TOCTOU fix (external review, P1): snapshot the caller-owned array BEFORE
  // the consumption pipeline runs, and read ONLY this snapshot (`ts`) for
  // everything from here on — never `tasks` again. Without this, a caller
  // that mutates `tasks` during the `await resolvePinnedBlock()` gap below
  // (e.g. `tasks[0] = freshTask` from a microtask) could substitute an
  // unconsumed task in for one `prepareRun` already marked consumed (that
  // substitute then executes without ever passing through the guard), while
  // the original — rightfully consumed — never runs. A `.slice()` up front
  // makes every subsequent read immune to such a mutation.
  const ts = tasks.slice()

  // F2 consumption pipeline (validate -> reject-duplicates -> pin-capability
  // -> mark-consumed), see `src/core/internal.ts`. Only branded tasks
  // (`defineTask`/`buildErc20Task`/`buildErc4626Task` output) are affected —
  // legacy `MultistepTask`s pass through every step as a no-op.
  const batchSize = prepareRun(ts, options)
  await resolvePinnedBlock()

  const maxStep = ts.reduce((max, task) => (task.maxStep > max ? task.maxStep : max), 0)

  for (let step = 1; step <= maxStep; step++) {
    const calls: StepCall[] = []
    const mapping: { taskIndex: number; key: string }[] = []

    for (let taskIndex = 0; taskIndex < ts.length; taskIndex++) {
      const task = ts[taskIndex]!
      if (step > task.maxStep) continue

      const stepCalls = task.buildStepCalls(step)
      for (const call of stepCalls) {
        calls.push(call)
        mapping.push({ taskIndex, key: call.key })
      }
    }

    // Pre-allocate a 2D array indexed by taskIndex for O(1) result grouping.
    // Avoids Map hashing overhead — taskIndex is sequential zero-based, so
    // array indexing is both faster and simpler.
    const perTaskResults: StepResult[][] = Array.from({ length: ts.length }, () => [])

    // Only hit the network when there are calls; a step where every active task
    // built nothing still dispatches empty results below (consistent per-step
    // notification regardless of sibling tasks).
    if (calls.length > 0) {
      // Split calls into batches to stay under per-call gas limits.
      // Each batch executes as a separate multicall round-trip.
      for (let batchStart = 0; batchStart < calls.length; batchStart += batchSize) {
        const batch = calls.slice(batchStart, batchStart + batchSize)
        const results = await executor.executeMulticall(batch, options?.block)

        // Dev-time guard: a misbehaving executor that returns fewer results than
        // calls would silently corrupt routing — fail loudly instead.
        if (results.length !== batch.length) {
          throw new Error(
            `StepExecutor returned ${results.length} results for ${batch.length} calls — length mismatch`,
          )
        }

        // Route this batch's results into the shared perTaskResults arrays.
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

    // Dispatch to every task active at this step — including those that built no
    // calls — so consumeStepResults is invoked consistently each step.
    for (let i = 0; i < ts.length; i++) {
      const task = ts[i]
      if (task && step <= task.maxStep) {
        task.consumeStepResults(step, perTaskResults[i]!)
      }
    }
  }

  return ts.map((task) => task.finalize())
}

export type { StepExecutor, StepCall, StepResult, RawResult }