/**
 * Internal single-use branding + consumption pipeline shared by
 * `runMultistepTasks` and `runSettled` (F2's reuse guard).
 *
 * **Why a brand at all:** `defineTask()` output and the built-in factory
 * outputs (`buildErc20Task`, `buildErc4626Task`) close over mutable `ctx`
 * state that is only ever valid for one run — reusing the same instance
 * would silently mix stale and fresh state. User-authored legacy
 * `MultistepTask` objects are NOT branded: auto-guarding them would be a new
 * runtime restriction in a minor release, and it would break legitimately
 * stateless, reusable custom tasks (pinned by
 * `src/__tests__/compat/legacy-tasks-1.0.test.ts`). So the guard is
 * opt-in-by-construction: only domino's own task constructors stamp it.
 *
 * **Why the consumption point is exactly here:** an earlier draft of this
 * guard marked a task consumed on its first executor call. That left
 * zero-call tasks (constant-only / derive-only `defineTask` builds, whose
 * `maxStep` is 0 because no `t.call` ever ran) reusable forever — the
 * executor loop never runs for them, so "first executor call" never
 * happens. Marking consumption as part of *accepting* a task into a run
 * (after validation, before any side effect) closes that hole: a
 * zero-call task is "run" the moment it's accepted, exactly like any other.
 *
 * **Why a WeakSet:** consumption state must not retain a task past its own
 * lifetime — a `WeakSet<object>` achieves that for free (no manual
 * cleanup, no unbounded growth across a long-lived process).
 *
 * **No creation-site stack capture:** the spec permits capturing a
 * dev-only creation stack trace to make the reuse error friendlier. This is
 * skipped: a `process.env` branch has no place in a bundle this library
 * ships to browsers (same reasoning the spec itself uses for G1's runtime
 * detection) and it costs bundle size for a nicety, not a correctness need.
 *
 * **Naming:** below this point, local/parameter names are deliberately
 * terse (`t`/`ts`/`o` for task/tasks/options) — a legacy artifact of a
 * retired raw-byte bundle budget. This module is 100% internal (never
 * imported outside `defineTask.ts`/`erc20.ts`/`erc4626.ts`/the two runners),
 * so future code should prefer descriptive names.
 */

import type { MultistepTask, StepExecutor, BlockParam, PinnedBlock } from './types'
import { DominoTaskReuseError } from './errors'

/**
 * Internal brand stamped on every `defineTask()` compiled task and every
 * `buildErc20Task()`/`buildErc4626Task()` return value. Never re-exported
 * from `src/index.ts` — it is not part of the public API, and a user task
 * that happened to define this symbol itself would be an abuse of an
 * internal implementation detail, not a supported way to opt in.
 */
export const SINGLE_USE: unique symbol = Symbol('domino.singleUse')

/** Structural type for a task carrying the single-use brand. Consumers never
 *  see this type — it's an internal intersection used only where a compiled
 *  task is constructed (`defineTask.ts`, `erc20.ts`, `erc4626.ts`). */
export interface SingleUseCarrier {
  [SINGLE_USE]?: true
}

/** Module-level singleton — one `WeakSet` shared by BOTH runners (not
 *  per-call state), so a task consumed via `runMultistepTasks` is correctly
 *  seen as consumed by a later `runSettled` call on the same instance, and
 *  vice versa. */
const consumed = new WeakSet<object>()

/**
 * Internal marker stamped on every compiled `StepCall` by `defineTask()`'s
 * `buildStepCalls` (F7 — relocated here from `defineTask.ts` so the engine
 * can read it without a cross-layer import back into the task-builder
 * module). `true` unless the originating `TypedCallSpec` had `dedupe:
 * false`; a hand-authored legacy `StepCall` never carries this symbol at
 * all, so `call[DEDUPE_ELIGIBLE] === true` is the one true "is this call
 * eligible for within-step dedup" check — see `src/core/dedupe.ts`.
 *
 * Deliberately NOT exported from `src/index.ts` (not even for tests):
 * presence/value are verified via `Object.getOwnPropertySymbols` +
 * `Symbol.description`, exactly as `SINGLE_USE` above.
 */
export const DEDUPE_ELIGIBLE: unique symbol = Symbol('domino.dedupeEligible')

/** TS-only convenience for the brand-check casts below — erased at compile
 *  time, so using it at 3 call sites (instead of a real `isBranded()`
 *  function) costs zero extra runtime bytes over one. */
type Branded<T> = MultistepTask<T> & SingleUseCarrier

/**
 * Numeric (+ two boolean) options validated + defaulted by `validateOptions`
 * (F6a/F6b/F7). All five ride through `prepareRun`'s return value.
 * `maxBatchAttempts` and `adaptiveBatching` are both consumed by the engine
 * (`src/core/engine.ts`/`src/core/pool.ts`, F6b) — `adaptiveBatching` gates
 * whether bisection ever runs at all; `maxBatchAttempts` bounds it once it
 * does. `dedupe` (F7) gates the engine's within-step, cross-task call
 * dedup — see `src/core/dedupe.ts`.
 */
export interface ValidatedRunOptions {
  batchSize: number
  maxConcurrentBatches: number
  maxBatchAttempts: number
  adaptiveBatching: boolean
  dedupe: boolean
}

/** Options `validateOptions` reads — a structural subset of `BatchOptions`. */
export interface NumericOptionsInput {
  batchSize?: number
  maxConcurrentBatches?: number
  maxBatchAttempts?: number
  adaptiveBatching?: boolean
  dedupe?: boolean
}

/**
 * Options `validatePinCapability`/`resolvePinnedBlock` read (F8) — a
 * structural subset of `BatchOptions`. Declared here rather than imported
 * from `runMultistepTasks.ts` for the same reason `NumericOptionsInput` is:
 * `runMultistepTasks.ts` already imports FROM this module, so importing
 * `BatchOptions` back would be circular.
 */
export interface PinOptionsInput {
  pinBlock?: boolean
  block?: BlockParam
  onPin?: (block: PinnedBlock) => void
}

/**
 * Shared positive-safe-integer check for all three F6a numeric fields.
 * `Number.isSafeInteger` (not `Number.isInteger`) — a value like `2**53`
 * passes `isInteger` but is not exactly representable, so it must still be
 * rejected; message wording is unchanged across all three fields (mirrors
 * the original `batchSize`-only message from 1.0/1.1).
 */
function validatePositiveSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got ${value}`)
  }
}

/**
 * Pipeline step 1 — numeric option validation (message/behavior for
 * `batchSize` alone unchanged from 1.0 in every case any existing test
 * exercises; F6a extends its check from `Number.isInteger` to
 * `Number.isSafeInteger` and adds the same check for `maxConcurrentBatches`/
 * `maxBatchAttempts`). A programmer error: failure does NOT consume
 * anything, because nothing has been touched yet.
 *
 * `maxBatchAttempts`'s default is computed from the RESOLVED `batchSize`
 * (so a caller-supplied `batchSize` changes the default), per the spec:
 * `2 * Math.ceil(Math.log2(batchSize)) + 1` — `batchSize: 1` gives
 * `log2(1) = 0`, `ceil(0) = 0`, default `1`.
 */
export function validateOptions(o: NumericOptionsInput | undefined): ValidatedRunOptions {
  const batchSize = o?.batchSize ?? 100
  validatePositiveSafeInteger('batchSize', batchSize)

  const maxConcurrentBatches = o?.maxConcurrentBatches ?? 1
  validatePositiveSafeInteger('maxConcurrentBatches', maxConcurrentBatches)

  const defaultMaxBatchAttempts = 2 * Math.ceil(Math.log2(batchSize)) + 1
  const maxBatchAttempts = o?.maxBatchAttempts ?? defaultMaxBatchAttempts
  validatePositiveSafeInteger('maxBatchAttempts', maxBatchAttempts)

  // Not a positive-safe-integer field — a plain boolean flag (F6b), default
  // `false` (see `BatchOptions.adaptiveBatching`'s doc comment for why: rate
  // limiting makes bisection's retry amplification actively harmful unless a
  // caller has opted in with knowledge of their transport's failure modes).
  const adaptiveBatching = o?.adaptiveBatching ?? false

  // Plain boolean flag (F7), default `false` — see `BatchOptions.dedupe`'s
  // doc comment. Off by default so dedup key computation never runs on the
  // hot path unless a caller opts in (`Presets.throughput` does).
  const dedupe = o?.dedupe ?? false

  return { batchSize, maxConcurrentBatches, maxBatchAttempts, adaptiveBatching, dedupe }
}

/**
 * Pipeline step 2 — scoped to branded tasks only. If the SAME branded
 * instance appears twice in one `tasks` array, that submission is rejected
 * outright — but nothing is consumed by this check: a later, separate
 * submission with that same (still-fresh) instance must still succeed.
 *
 * Legacy (unbranded) duplicate instances in one array keep 1.0 behavior (no
 * throw) — a consumer's own stateless task passed twice in one array is a
 * supported pattern (see the "allows reusing hand-written stateless task"
 * pin in `src/__tests__/compat/legacy-tasks-1.0.test.ts`); auto-rejecting it
 * would be a new restriction on user code this guard was never meant to add.
 *
 * One pass, O(n): a `Set<object>` of branded instances seen so far, allocated
 * lazily on the first branded task (a fully-unbranded submission — the
 * common case for legacy consumers — never allocates it at all). External
 * review (P2) flagged the previous `indexOf`-based scan as O(n²) — bulk
 * resolvers can submit fully-branded arrays, where an O(n²) scan is a real
 * cost at scale (10k entries ≈ 50M comparisons).
 */
export function rejectDuplicateInstances<T>(ts: MultistepTask<T>[]): void {
  let seen: Set<MultistepTask<T>> | undefined
  for (const t of ts) {
    if (!(t as Branded<T>)[SINGLE_USE]) continue
    seen ??= new Set()
    if (seen.has(t)) {
      throw new DominoTaskReuseError(
        'Same task instance passed twice in one submission: domino tasks are single-run — ' +
          'create a fresh task for each entry',
      )
    }
    seen.add(t)
  }
}

/**
 * Pipeline step 3 (F8) — checks whether this run's block-pinning request is
 * satisfiable, and throws before anything is consumed if not. A no-op
 * whenever `pinBlock` isn't set (the overwhelmingly common case — this
 * function never even looks at `executor` or `block` then).
 *
 * Runs BEFORE `markTasksConsumed`: a capability rejection must never leave
 * the rejected submission's tasks consumed — this is exactly the ordering
 * `prepareRun` already documents, now filled in.
 *
 * Two checks, both spec-literal:
 *
 * (a) **Capability**: `pinBlock: true` against an executor that doesn't
 *     implement `getBlockNumber` throws — ALWAYS, even when the caller's
 *     `block` is an explicit `blockNumber`/`blockHash` that would never
 *     actually need to CALL `getBlockNumber` (see `resolvePinnedBlock`
 *     below). This is deliberate: `pinBlock` is a predictable capability
 *     contract on the executor, not a "throw only if we happen to need the
 *     RPC this time" heuristic — a caller who later switches their `block`
 *     to a tag shouldn't have that switch silently start throwing on an
 *     executor they'd already been using with `pinBlock: true`.
 * (b) **Tag support**: `block: { blockTag: 'pending' }` throws — `pending`
 *     has no stable block number, so pinning it is a contradiction in
 *     terms, not something resolvable by picking a number. Every other,
 *     STABLE tag (`latest`/`earliest`/`safe`/`finalized`), an explicit
 *     `blockNumber`, an explicit `blockHash`, and an absent `block`
 *     (implicit `'latest'`) are all fine here — `resolvePinnedBlock` is
 *     what actually branches on which.
 */
export function validatePinCapability(options: PinOptionsInput | undefined, executor: StepExecutor): void {
  if (!options?.pinBlock) return

  if (typeof executor.getBlockNumber !== 'function') {
    throw new Error(
      'pinBlock: true requires a StepExecutor implementing getBlockNumber(block?) — this executor ' +
        'does not support block pinning (Eip1193Executor implements it; a custom StepExecutor must ' +
        'add it to opt in)',
    )
  }

  if (options.block && 'blockTag' in options.block && options.block.blockTag === 'pending') {
    throw new Error(
      "pinBlock: true does not support blockTag 'pending' — pending has no stable block number",
    )
  }
}

/**
 * Pipeline step 4 — check-then-mark, atomically. First scans every branded
 * task in `tasks`; if ANY is already consumed, throws WITHOUT marking
 * anything (a failed submission must not consume its sibling tasks — a
 * retried submission containing the still-fresh siblings must succeed).
 * Only once the scan passes clean are all branded tasks marked consumed.
 *
 * Zero-call / finalize-only tasks are marked exactly like any other branded
 * task — see the module doc comment for why that's the whole point of doing
 * this here (after validation/dedup-rejection, before any run-side effect)
 * rather than at the first executor call.
 */
export function markTasksConsumed<T>(ts: MultistepTask<T>[]): void {
  for (const t of ts) {
    if ((t as Branded<T>)[SINGLE_USE] && consumed.has(t)) {
      throw new DominoTaskReuseError(
        'Task instance already consumed: domino tasks are single-run — create a fresh task ' +
          'for each run (factories such as buildErc20Task/defineTask return a fresh instance ' +
          'per call)',
      )
    }
  }
  for (const t of ts) if ((t as Branded<T>)[SINGLE_USE]) consumed.add(t)
}

/**
 * Pipeline step 5 (F8) — resolves the ONE effective block every step of this
 * run will use, and (when `pinBlock` is set) synchronously reports it via
 * `onPin`. Deliberately runs AFTER `markTasksConsumed`: a failure here means
 * execution has already begun (calls are about to be dispatched), so by
 * design the tasks are left consumed — the same rule the step loop itself
 * already follows for any later failure (see the executor-rejection-after-
 * consumption test in `singleUse.test.ts`).
 *
 * `pinBlock` false/absent (the default): a pure no-op — returns
 * `options?.block` completely untouched, so callers see byte-identical
 * behavior to every pre-F8 release (including "block omitted" staying
 * `undefined`, never defaulted here).
 *
 * `pinBlock: true` — by this point `validatePinCapability` has already
 * guaranteed `executor.getBlockNumber` exists and `block.blockTag` isn't
 * `'pending'`:
 *   - `block` absent, or carrying any STABLE `blockTag`
 *     (`'latest' | 'earliest' | 'safe' | 'finalized'` — anything but
 *     `'pending'`, already rejected by `validatePinCapability`):
 *     `await executor.getBlockNumber(block)` (the ONE extra round-trip
 *     pinning costs) resolves a concrete number; the effective block for
 *     every step becomes `{ blockNumber: resolved }`, and that's also the
 *     `PinnedBlock` reported to `onPin`.
 *   - explicit `{ blockNumber }`: no RPC — used as-is, reported as-is.
 *   - explicit `{ blockHash, requireCanonical? }`: no RPC — used as-is
 *     (`requireCanonical` untouched), reported as
 *     `{ blockHash, requireCanonical }` with the key omitted entirely when
 *     the caller didn't supply it (`exactOptionalPropertyTypes`-safe: an
 *     omitted key must be genuinely absent, not present-with-`undefined`).
 *
 * `onPin`, when provided, is called exactly once, SYNCHRONOUSLY (a direct
 * call, no microtask hop introduced here beyond whatever `await
 * getBlockNumber()` already caused) — and only ever reached when
 * `pinBlock` is true; a caller who passes `onPin` without `pinBlock` gets it
 * silently never invoked (see `BatchOptions.onPin`'s doc comment). If it
 * throws, that throw is this function's rejection: the caller (`run`/
 * `runSettled`) sees it as `resolvePinnedBlock`'s own failure, tasks stay
 * consumed (already marked, above), and — because this function is always
 * `await`ed strictly before the step loop starts — no `executeMulticall`
 * call has been dispatched yet.
 */
export async function resolvePinnedBlock(
  options: PinOptionsInput | undefined,
  executor: StepExecutor,
): Promise<BlockParam | undefined> {
  if (!options?.pinBlock) return options?.block

  const requested = options.block
  let effectiveBlock: BlockParam
  let pinned: PinnedBlock

  if (requested && 'blockNumber' in requested) {
    effectiveBlock = requested
    pinned = { blockNumber: requested.blockNumber }
  } else if (requested && 'blockHash' in requested) {
    effectiveBlock = requested
    pinned =
      requested.requireCanonical !== undefined
        ? { blockHash: requested.blockHash, requireCanonical: requested.requireCanonical }
        : { blockHash: requested.blockHash }
  } else {
    // Absent, or an explicit blockTag — 'pending' is already impossible here
    // (validatePinCapability rejected it pre-consumption).
    const resolved = await executor.getBlockNumber!(requested)
    effectiveBlock = { blockNumber: resolved }
    pinned = { blockNumber: resolved }
  }

  options.onPin?.(pinned)
  return effectiveBlock
}

/**
 * Shared synchronous prefix of both runners' bodies: validate numeric
 * options → reject duplicate branded instances → pin-capability check →
 * mark branded tasks consumed. Returns the validated options bundle so each
 * runner can drop this straight in place of its old inline validation.
 *
 * Takes `executor` (F8) purely to hand it to `validatePinCapability` — this
 * function still runs entirely synchronously (the capability check is sync;
 * only `resolvePinnedBlock`, next, needs `await`).
 *
 * Deliberately stops here (not shared with `resolvePinnedBlock`/the step
 * loop): `run()`/`runSettled()` diverge in failure handling once execution
 * actually starts, so those stay in each runner's own body (see
 * `src/core/engine.ts`'s `runSteps` for the part that IS now shared).
 */
export function prepareRun<T>(
  ts: MultistepTask<T>[],
  o: (NumericOptionsInput & PinOptionsInput) | undefined,
  executor: StepExecutor,
): ValidatedRunOptions {
  const validated = validateOptions(o)
  rejectDuplicateInstances(ts)
  validatePinCapability(o, executor)
  markTasksConsumed(ts)
  return validated
}
