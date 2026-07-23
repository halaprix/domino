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
import { runSteps, type StepEnginePolicy } from './engine'

/**
 * Options for runMultistepTasks.
 */
export interface BatchOptions {
  /**
   * Maximum number of calls per multicall batch.
   *
   * Multicall3 aggregate3 has a per-call gas limit. When a single step has
   * more than this many calls, it is split into sequential batches.
   * Default: 100. Must be a positive safe integer ≥ 1 — anything else throws.
   */
  batchSize?: number

  /**
   * Concurrency-limited pool size for dispatching physical batches within a
   * single step (F6a). Batches are dispatched in original index order as
   * permits free; routing is index-based and does not depend on completion
   * order. Default: 1 (genuinely sequential — batch k+1 is not dispatched
   * until batch k settles, bit-identical to the pre-F6a behavior). Must be
   * a positive safe integer ≥ 1 — anything else throws.
   *
   * **Cancellation policy (fail-fast):** on the first batch whose executor
   * call rejects, no further queued batches for that step are dispatched;
   * batches already in flight are allowed to settle (their results
   * discarded); once every in-flight batch has settled, the run rejects
   * with the selected terminal error (see `src/core/pool.ts` for the exact
   * selection rule). This is deterministic only when exactly one batch
   * fails irrecoverably — with multiple concurrently-failing batches, which
   * one's error is thrown is explicitly unspecified (timing-dependent).
   */
  maxConcurrentBatches?: number

  /**
   * Maximum retry attempts for a failing physical batch before it is
   * treated as a terminal failure (adaptive bisection, F6b) — counted PER
   * ORIGINAL batch: every execution of that original batch or any of its
   * bisected sub-batches counts, successful or not, including the
   * original's own first execution. Default:
   * `2 * Math.ceil(Math.log2(batchSize)) + 1`. Must be a positive safe
   * integer ≥ 1 — anything else throws. Only consulted when
   * `adaptiveBatching` is `true`.
   *
   * Fully isolating every bad call in a batch can require up to `2N − 1`
   * executions (`N` = batch size) in the worst case (multiple bad calls
   * spread across the batch). The default cap is sized for the common
   * single-bad-call case; a batch with multiple failing calls may exhaust
   * it before every one is individually isolated — under `runSettled` this
   * produces one or more coarser-grained `kind: 'batch'` failures instead of
   * fully isolated ones, never wrong data (unaffected calls always keep
   * their real values).
   */
  maxBatchAttempts?: number

  /**
   * Enable adaptive bisection (F6b): when a physical batch's executor call
   * rejects (a transport/RPC-level failure — never a per-call revert, which
   * is already isolated via `allowFailure`) and the batch has more than one
   * call, split it in half and retry both halves independently instead of
   * treating the whole batch as failed. Recurses until either every call is
   * isolated to its own single-call execution, or `maxBatchAttempts` is
   * exhausted for that original batch. Default: `false`.
   *
   * **Off by default.** Bisection cannot distinguish a genuine per-call
   * failure (e.g. an out-of-gas call poisoning its whole batch) from a
   * transient transport problem like HTTP 429 rate-limiting — under rate
   * limiting, retrying amplifies load into an already-throttled endpoint by
   * up to `2N − 1` calls for a single original batch. Enable this once you
   * know your transport/RPC failures are dominated by genuinely bad calls,
   * not rate limits; leave it off (or handle 429s at the transport layer)
   * otherwise. A future failure-cause classification may allow enabling
   * this safely by default.
   *
   * With this off, `run` and `runSettled` are both byte-for-byte identical
   * to their pre-F6b (1.1) behavior — a batch rejection is terminal
   * immediately, `maxBatchAttempts` is never consulted.
   */
  adaptiveBatching?: boolean

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
  const { batchSize, maxConcurrentBatches, adaptiveBatching, maxBatchAttempts } = prepareRun(ts, options)
  await resolvePinnedBlock()

  // `run`'s fail-fast policy (F6a/F6b) — see `src/core/engine.ts`'s doc
  // comment for the full hook contract. `buildStepCalls`/`consumeStepResults`
  // let a throw propagate untouched (a plain synchronous throw inside this
  // async function's body, exactly like the pre-F6a code). `executeBatch` is
  // the raw, unwrapped executor call — nothing here branches on
  // `adaptiveBatching`, because bisection is entirely the POOL's decision
  // (see `src/core/pool.ts`), not this policy's: the exact same call works
  // whether the pool hands it a whole batch or a bisected sub-batch. The
  // length-mismatch guard also now lives in the pool (checked uniformly
  // after any `execute()` resolves) rather than here — see its doc comment
  // for why that's also what makes "never retried" free. `recordTerminal` is
  // deliberately NOT provided: a terminal batch (single-call rejection, or
  // the attempts cap exhausted) always triggers the pool's fail-fast
  // cancellation, exactly as T14, whether or not bisection ever ran.
  const policy: StepEnginePolicy = {
    buildStepCalls(taskIndex, step) {
      const task = ts[taskIndex]!
      if (step > task.maxStep) return undefined
      return task.buildStepCalls(step)
    },

    executeBatch(batch) {
      return executor.executeMulticall(batch, options?.block)
    },

    consumeStepResults(taskIndex, step, results) {
      const task = ts[taskIndex]
      if (task && step <= task.maxStep) {
        task.consumeStepResults(step, results)
      }
    },
  }

  await runSteps(ts, { batchSize, maxConcurrentBatches, adaptiveBatching, maxBatchAttempts }, policy)

  return ts.map((task) => task.finalize())
}

export type { StepExecutor, StepCall, StepResult, RawResult }