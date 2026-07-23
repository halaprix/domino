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

import type { MultistepTask, StepCall, StepResult, StepExecutor, RawResult, BlockParam, PinnedBlock } from './types'
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

  /**
   * Block to query at (defaults to 'latest'). Same block PARAMETER used for
   * every step's `executeMulticall` call — but without `pinBlock: true`,
   * that does not mean every step reads the same STATE: a tag like
   * `'latest'`/`'safe'`/`'finalized'` is re-resolved by the node on every
   * separate `eth_call`, so the chain can advance between steps. See
   * `pinBlock` below (and the "Atomicity" section in `docs/api-reference.md`)
   * to remove that gap.
   */
  block?: BlockParam

  /**
   * Enable block pinning (F8): resolve ONE concrete block at the very start
   * of the run and reuse it for every step's `executeMulticall` call,
   * closing the "chain advanced between steps" gap `block` alone leaves
   * open (see its doc comment above). Default: `false`.
   *
   * Resolution (see `resolvePinnedBlock` in `src/core/internal.ts` for the
   * full contract):
   * - `block` absent, or `{ blockTag: 'latest' | 'safe' | 'finalized' }` —
   *   resolved via `executor.getBlockNumber(block)` (one extra round-trip);
   *   every step then queries `{ blockNumber: <resolved> }`.
   * - `block: { blockTag: 'pending' }` — throws before any task is consumed.
   *   `pending` has no stable block number; pinning it is unsupported.
   * - explicit `block: { blockNumber }` — no-op, no extra RPC: already a
   *   single concrete block.
   * - explicit `block: { blockHash, requireCanonical? }` — no-op, no extra
   *   RPC, `requireCanonical` preserved untouched.
   *
   * Requires a `StepExecutor` implementing `getBlockNumber` — `true` against
   * an executor that lacks it throws immediately (before anything is
   * consumed), regardless of which `block` shape was passed (a predictable
   * capability contract, not a "only if we happen to need the RPC" check).
   * `Eip1193Executor` implements it; a custom `StepExecutor` opts in the
   * same way.
   */
  pinBlock?: boolean

  /**
   * Synchronous callback reporting the block a `pinBlock: true` run resolved
   * (F8) — invoked exactly once per run, with the resolved `PinnedBlock`.
   * Mapping: a resolved tag or an explicit `blockNumber` reports
   * `{ blockNumber }`; an explicit `blockHash` reports
   * `{ blockHash, requireCanonical }` (no extra RPC is ever made just to
   * learn its number). **Only invoked when `pinBlock` is `true`** — supplying
   * `onPin` without `pinBlock` is accepted but it is simply never called.
   *
   * If `onPin` throws, the run rejects with that error: tasks are already
   * marked consumed by this point (block resolution happens after the
   * consumption pipeline — see `src/core/internal.ts`), and no multicall
   * batch has been dispatched yet.
   */
  onPin?: (block: PinnedBlock) => void

  /**
   * Enable within-step, cross-task call dedup (F7): before the wire list for
   * a step reaches batching/bisection, calls that are dedup-ELIGIBLE and
   * share the same `(target.toLowerCase(), calldata, canonicalOutputSignature)`
   * key are merged into a single physical call — its result (success or
   * failure) is then fanned out to every subscriber. Default: `false`.
   *
   * **Eligibility is per-call**, not per-run: a hand-authored legacy
   * `StepCall` is never eligible (no mutability promise was ever made for
   * it), so turning this on can never change legacy-task semantics — see
   * `TypedCallSpec.dedupe` (default `true`; set `dedupe: false` on an
   * individual call to opt it out). `view`/`pure` alone do not guarantee
   * referential transparency, hence "eligible", not "safe" — this is a
   * caller opt-in, not something inferred from ABI mutability.
   *
   * **Conflicting output ABIs never merge:** calldata alone (selector +
   * inputs) does not capture how a caller intends to DECODE the result — two
   * subscribers declaring different output shapes for identical calldata are
   * kept as separate wire calls, each decoding correctly against its own
   * ABI, so dedup can never silently corrupt one decoder with another's
   * shape.
   *
   * See `Presets.throughput` for a ready-made bundle that turns this on
   * together with `maxConcurrentBatches`/`adaptiveBatching`.
   */
  dedupe?: boolean
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
  const { batchSize, maxConcurrentBatches, adaptiveBatching, maxBatchAttempts, dedupe } = prepareRun(
    ts,
    options,
    executor,
  )
  // F8: the ONE effective block every step's executeMulticall uses — either
  // `options?.block` untouched (pinBlock off/absent, the default) or the
  // resolved pin (see `resolvePinnedBlock`'s doc comment in
  // `src/core/internal.ts`). Replaces the old direct `options?.block` read
  // in `executeBatch` below.
  const effectiveBlock = await resolvePinnedBlock(options, executor)

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
      return executor.executeMulticall(batch, effectiveBlock)
    },

    consumeStepResults(taskIndex, step, results) {
      const task = ts[taskIndex]
      if (task && step <= task.maxStep) {
        task.consumeStepResults(step, results)
      }
    },
  }

  await runSteps(ts, { batchSize, maxConcurrentBatches, adaptiveBatching, maxBatchAttempts, dedupe }, policy)

  return ts.map((task) => task.finalize())
}

export type { StepExecutor, StepCall, StepResult, RawResult }