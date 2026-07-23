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

import type { MultistepTask } from './types'
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

/** TS-only convenience for the brand-check casts below — erased at compile
 *  time, so using it at 3 call sites (instead of a real `isBranded()`
 *  function) costs zero extra runtime bytes over one. */
type Branded<T> = MultistepTask<T> & SingleUseCarrier

/**
 * Pipeline step 1 — the existing `batchSize` validation (message/behavior
 * unchanged from 1.0). A programmer error: failure does NOT consume
 * anything, because nothing has been touched yet.
 */
export function validateOptions(batchSize: number | undefined): number {
  const resolved = batchSize ?? 100
  if (!Number.isInteger(resolved) || resolved < 1)
    throw new Error(`batchSize must be a positive integer, got ${resolved}`)
  return resolved
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
 * Pipeline step 3 — named no-op seam. F8/T17 (pinBlock capability) fills
 * this in: it will check whether the executor supports the block-pinning
 * capability the run requires and throw if not. Must run — and, once
 * implemented, must throw — BEFORE `markTasksConsumed`: a capability
 * rejection must never leave the rejected submission's tasks consumed.
 * Takes no arguments today; F8/T17 adds whatever it needs (tasks/options)
 * when it fills this in.
 */
export function validatePinCapability(): void {
  // Intentionally empty until F8/T17.
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
 * Pipeline step 5 — named async no-op seam. F8/T17 (pinBlock resolution)
 * fills this in with an `await getBlockNumber()`-style call. Deliberately
 * runs AFTER `markTasksConsumed`: a failure here means execution has already
 * begun (calls are about to be dispatched), so by design the tasks are left
 * consumed — the same rule `executeSteps` itself already follows for any
 * later failure. Takes no arguments today; F8/T17 adds whatever it needs
 * (tasks/options) when it fills this in with an `await getBlockNumber()`.
 */
export async function resolvePinnedBlock(): Promise<void> {
  // Intentionally empty until F8/T17.
}

/**
 * Shared synchronous prefix of both runners' bodies: validate batchSize →
 * reject duplicate branded instances → pin-capability check → mark branded
 * tasks consumed. Returns the validated `batchSize` so each runner can drop
 * this straight in place of its old inline validation.
 *
 * Deliberately stops here (not shared with `resolvePinnedBlock`/the step
 * loop): `run()`/`runSettled()` diverge in failure handling once execution
 * actually starts, so those stay in each runner's own body.
 */
export function prepareRun<T>(ts: MultistepTask<T>[], o: { batchSize?: number } | undefined): number {
  const batchSize = validateOptions(o?.batchSize)
  rejectDuplicateInstances(ts)
  validatePinCapability()
  markTasksConsumed(ts)
  return batchSize
}
