/**
 * Concurrency-limited batch dispatch pool + fail-fast cancellation (F6a).
 *
 * `runBatchPool` is the one piece of genuinely new machinery this feature
 * adds. It knows nothing about tasks, steps, or which runner (`run` vs
 * `runSettled`) is calling it — only "batches" (`StepCall[]`) and an
 * `execute` callback that resolves with `RawResult[]` or rejects. See
 * `src/core/engine.ts` for how the two runners' policies feed this.
 *
 * **Why `runSettled` "never cancels" needs no special case here:**
 * `runSettled`'s `executeBatch` policy (see `runSettled.ts`) catches every
 * ordinary transport rejection itself and *resolves* with synthesized
 * per-call `kind:'batch'` `DominoCallError`s — so, from this module's point
 * of view, that `execute` callback simply never rejects for a call failure.
 * The cancellation machinery below is real code that runs for `runSettled`
 * too (nothing is skipped), it just never gets triggered because nothing
 * ever throws into it. `runSettled`'s `executeBatch` DOES still reject for
 * the length-mismatch executor-bug case — and when it does, this pool's
 * ordinary fail-fast handling applies (matches the existing "aborts
 * runSettled entirely" behavior for that case, unchanged from 1.0/1.1 at
 * the default `maxConcurrentBatches: 1`).
 *
 * ## Cancellation policy — spec (a)-(d)
 *
 * (a) **Queued batches are not dispatched.** Every worker checks the shared
 *     `cancelled` flag BEFORE claiming its next batch index. Claiming
 *     (`nextIndex++`) and the check happen with no `await` between them, so
 *     — JavaScript being single-threaded/run-to-completion between awaits —
 *     two workers can never claim the same index, and once `cancelled`
 *     flips, no worker claims a further index.
 *
 * (b) **In-flight batches are allowed to settle; no unhandled rejections.**
 *     A worker that has already claimed a batch keeps `await`-ing it to
 *     completion regardless of `cancelled` (there is no way to abort an
 *     in-flight promise, and the spec requires letting it finish rather
 *     than abandoning it). Because every batch's promise is awaited
 *     directly inside its own worker's `try/catch` — never handed off
 *     un-awaited — there is never a floating rejection for the runtime to
 *     report as `unhandledRejection`. The spec's "attach `.catch(noop)`"
 *     requirement falls out of this shape for free; there is no separate
 *     `.catch()` bolted onto anything.
 *
 * (c) **Thrown error = lowest (batchIndex, callIndex) among DISCOVERED
 *     terminal errors.** Every worker that observes a rejection pushes
 *     `{ batchIndex, callIndex, error }` onto a shared list; once all
 *     workers finish, the lowest entry (by this module's `compareTerminal`)
 *     is returned. "Discovered" is exactly "belongs to a batch that was
 *     actually claimed" — a batch still queued when cancellation triggers
 *     never contributes an entry. `callIndex` is always `0` in this
 *     feature slice (T14): every terminal error today is whole-batch, so
 *     there is no finer-grained call index yet. The shape survives
 *     bisection (T15) unmodified — a future per-call terminal discovered
 *     inside a split sub-batch will carry its own real `callIndex`, and the
 *     comparator needs no redesign.
 *
 *     For exactly one failing batch, the selected error is deterministic
 *     regardless of timing: dispatch always claims indices in ascending
 *     order, so the single poisoned batch is always eventually claimed (no
 *     other rejection exists to stop the pool before that happens), and it
 *     always settles (in-flight batches are never abandoned, per (b)) — so
 *     the discovered-error list always ends up with exactly that one entry.
 *     With two or more concurrently-failing batches, whether a lower-index
 *     poisoned batch was already claimed by the time a higher-index one's
 *     rejection flips `cancelled` depends on the concurrency window and
 *     relative delay — genuinely timing-dependent, as the spec states.
 *
 * (d) **Results of in-flight batches are discarded.** A batch's result is
 *     only written into the shared `results` array `if (!cancelled)` at the
 *     moment it settles; a cancelled run's `results` array is never even
 *     inspected — see `runSteps` in `src/core/engine.ts`, which throws
 *     immediately on a `cancelled` outcome instead of routing anything.
 *
 * **`maxConcurrentBatches: 1` is not special-cased.** `workerCount = min(1,
 * batchCount) = 1` naturally yields exactly one worker processing batches
 * strictly in order, one at a time — on rejection there is no other worker
 * with anything in flight, so the pool immediately reports `cancelled` with
 * the untouched original error object. This is bit-identical to the
 * pre-F6a sequential path, including error identity (pinned by the compat
 * suite and `singleUse.test.ts`).
 *
 * **Forward-compat note (T15):** `batches.length` is read fresh on every
 * loop check rather than captured once up front. This costs nothing today
 * (the array is never mutated after `runSteps` builds it), but means a
 * future "central per-step queue" that pushes split child batches onto this
 * same array mid-run would already be picked up by the existing workers
 * without a redesign.
 */

import type { StepCall, RawResult } from './types'

/** All batches ran to completion — `results[i]` is batch `i`'s `RawResult[]`. */
export interface BatchPoolCompleted {
  outcome: 'completed'
  results: RawResult[][]
}

/** Fail-fast triggered — `error` is the selected terminal error (see (c) above). */
export interface BatchPoolCancelled {
  outcome: 'cancelled'
  error: unknown
}

export type BatchPoolOutcome = BatchPoolCompleted | BatchPoolCancelled

/** One discovered terminal error, tagged with where it came from — see (c). */
interface TerminalCandidate {
  batchIndex: number
  callIndex: number
  error: unknown
}

/**
 * Orders discovered terminal errors for spec (c)'s selection rule: lowest
 * original batch index, then lowest call index within that batch. Every
 * T14 terminal is whole-batch (`callIndex` always `0`), so this currently
 * degrades to plain `batchIndex` ordering — kept as a 2-key comparator so
 * bisection (T15) can slot per-call terminals in without redesigning this
 * function.
 */
function compareTerminal(a: TerminalCandidate, b: TerminalCandidate): number {
  if (a.batchIndex !== b.batchIndex) return a.batchIndex - b.batchIndex
  return a.callIndex - b.callIndex
}

/**
 * Dispatch `batches` through `execute` with at most `maxConcurrentBatches`
 * in flight at once, in original index order, applying fail-fast
 * cancellation ((a)-(d) above) the instant any dispatched batch rejects.
 *
 * `maxConcurrentBatches` is clamped to `batches.length` — requesting more
 * workers than there are batches would just spin up idle workers that exit
 * immediately.
 */
export async function runBatchPool(
  batches: StepCall[][],
  maxConcurrentBatches: number,
  execute: (batch: StepCall[], batchIndex: number) => Promise<RawResult[]>,
): Promise<BatchPoolOutcome> {
  if (batches.length === 0) return { outcome: 'completed', results: [] }

  const results: RawResult[][] = new Array(batches.length)
  const terminalErrors: TerminalCandidate[] = []
  let nextIndex = 0
  let cancelled = false

  async function worker(): Promise<void> {
    for (;;) {
      if (cancelled) return
      if (nextIndex >= batches.length) return
      const batchIndex = nextIndex
      nextIndex++
      const batch = batches[batchIndex]!
      try {
        const batchResults = await execute(batch, batchIndex)
        if (!cancelled) results[batchIndex] = batchResults
      } catch (error) {
        cancelled = true
        terminalErrors.push({ batchIndex, callIndex: 0, error })
      }
    }
  }

  const workerCount = Math.min(maxConcurrentBatches, batches.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))

  if (terminalErrors.length > 0) {
    terminalErrors.sort(compareTerminal)
    return { outcome: 'cancelled', error: terminalErrors[0]!.error }
  }

  return { outcome: 'completed', results }
}
