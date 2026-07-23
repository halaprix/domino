/**
 * Concurrency-limited batch dispatch pool + fail-fast cancellation (F6a),
 * extended with adaptive bisection (F6b) — split-and-retry on a
 * batch-level transport rejection, bounded by a per-original-batch attempts
 * cap, coordinated entirely through this module's own central queue.
 *
 * `runBatchPool` is the one piece of genuinely new machinery this feature
 * area adds. It knows nothing about tasks, steps, or which runner (`run` vs
 * `runSettled`) is calling it — only "batches" (`StepCall[]`), an `execute`
 * callback that resolves with `RawResult[]` or rejects, and (F6b) an
 * optional `BisectionPolicy` describing whether/how hard to retry a
 * rejection and what a caller wants done with a TERMINAL one. See
 * `src/core/engine.ts` for how the two runners' policies feed both of these.
 *
 * ## The queue (F6b)
 *
 * Work items are `{ calls, origBatchIndex, origOffset }` — `origBatchIndex`
 * is which of the ORIGINAL `batches` this item's calls ultimately belong to;
 * `origOffset` is where in that original batch's call list this item's
 * calls start. The queue is seeded with exactly one whole-batch item per
 * original batch (`origOffset: 0`) — this degrades to T14's flat batch list
 * whenever nothing is ever split.
 *
 * Workers claim by `nextIndex++` exactly as T14 did for `batches` — reading
 * `queue.length` fresh on every loop check (T14's "forward-compat" note
 * anticipated exactly this: a future queue that grows mid-run needs no
 * dedicated wake-up, because the length check already re-reads live). On a
 * retryable rejection (`adaptive` && the item has more than one call), the
 * worker `queue.push()`es the two half-sized children and immediately loops
 * to claim whatever's next — **it never awaits its own children.**
 *
 * **This is the whole no-deadlock argument.** A "permit" here is nothing
 * more than "being one of the `maxConcurrentBatches` running `worker()`
 * loops" — there is no separate semaphore object to release. Splitting is a
 * synchronous `queue.push()` followed immediately by `continue`; the worker
 * moves on to claim the NEXT queued item (which may be one of the children
 * it just pushed, or may belong to an entirely different original batch —
 * whichever is lowest-indexed and unclaimed). A pool of size 1 therefore
 * just serially drains however many splits the poisoned call(s) need, one
 * `execute()` at a time, with nothing ever waiting on anything the SAME
 * worker itself hasn't already finished. There is no recursive await for a
 * deadlock to hide in.
 *
 * ## Attempts accounting (F6b)
 *
 * `attempts`/`lastError`, both indexed by `origBatchIndex` (never by queue
 * position — a split child shares its parent's `origBatchIndex`). The cap
 * is enforced in exactly one place: at CLAIM time, before every execution —
 * the original batch's own first one included, and every bisected child.
 * `attempts[i] >= maxBatchAttempts` means "do not execute" — the item goes
 * straight to TERMINAL using `lastError[i]` (the most recent transport
 * rejection seen for that original, which may have come from a *sibling*
 * item, not this one — this one was never executed at all). Otherwise
 * `attempts[i]++` then execute.
 *
 * A rejection ALSO re-checks the cap itself, synchronously, before deciding
 * to split (external review, P1): if `attempts[i]` has already reached
 * `maxBatchAttempts` — i.e. this execution WAS the original's last allowed
 * one — the item terminalizes immediately, right here, instead of pushing
 * children that would merely be exhausted later, AT CLAIM TIME, by the check
 * above. This is not just an optimization: those children only reach the
 * claim-time check if a worker actually claims them, and once `cancelled` is
 * true (a *sibling* original's own terminal, discovered concurrently, always
 * wins the race unconditionally — no worker claims anything further once it
 * flips), a queued item is — correctly, per (a) below — never claimed at
 * all. Deferring a KNOWN exhaustion to "push children and hope they get
 * claimed" would silently drop this item's own terminal error from
 * `terminalErrors` whenever cancellation from elsewhere wins that race,
 * corrupting both `cause = last transport error` and the lowest-
 * `(batchIndex, callIndex)` selection in (c) below. Catching the exhausted
 * case synchronously, in the same tick as the rejection that caused it,
 * guarantees this item's own terminal is recorded regardless of what any
 * other in-flight item does.
 *
 * When attempts DO remain, a rejection unconditionally pushes both halves —
 * each child's own fate (execute, or find itself exhausted) is then decided
 * independently at ITS OWN claim time, per the paragraph above. This is what
 * produces the spec's "coarse group" behavior for free when the cap runs
 * out mid-tree AFTER this point: whichever children can't get a claim-time
 * attempt slot become terminal together, using the same `lastError[i]`, with
 * no special-casing needed beyond the exhausted-at-rejection-time check just
 * described.
 *
 * ## Terminal policy hook (F6b)
 *
 * `BisectionPolicy.recordTerminal` — present only for a runner that never
 * wants the whole pool cancelled on a terminal item (`runSettled`):
 *
 *   - **Absent (`run`):** a terminal item triggers T14's fail-fast
 *     cancellation verbatim — see (a)-(d) below, now generalized so
 *     `callIndex` is a REAL offset (`origOffset`) instead of always `0`.
 *     `compareTerminal`'s 2-key ordering needed no change to support this —
 *     T14's doc comment called this out as the exact reason it was already
 *     shaped as a 2-key comparator.
 *   - **Present (`runSettled`):** called once per terminal item with that
 *     item's calls and the last transport error for its original batch;
 *     returns one `RawResult` per call (same order). The pool writes that
 *     array into the shared per-original results row at
 *     `[origOffset, origOffset + calls.length)` and does NOT cancel — other
 *     items (siblings, other originals) keep going exactly like a normal
 *     success.
 *
 * Only two runners exist, so "hook present vs absent" is a sufficient policy
 * signal; there is no separate cancel/never-cancel enum.
 *
 * Bisection retries ONLY a rejection from `execute()` itself — it can never
 * see or touch a per-call revert/failure carried inside a RESOLVED
 * `RawResult[]` (`allowFailure`-style); the entire retry/terminal machinery
 * lives inside the `catch` block below, which a resolution never reaches.
 *
 * ## Length-mismatch (programmer error) — never retried, both runners abort
 *
 * Checked directly here, right after ANY `execute()` resolves (whole batch
 * or bisected child): `batchResults.length !== calls.length`. This is a
 * plain post-resolve `if`, not something that arrives through the `catch`
 * block — so it can never be mistaken for a retryable transport rejection,
 * needs no marker-error/`instanceof` trick to distinguish the two, and
 * unconditionally takes the same `cancelWith(...)` path T14 used for every
 * rejection, ignoring `recordTerminal` entirely. That reproduces "aborts
 * everything, for both runners" for free — `runSettled` still aborts
 * wholesale on this, exactly as it did before bisection existed.
 *
 * ## Cancellation policy — spec (a)-(d), generalized from T14
 *
 * (a) **Queued items are not dispatched.** Every worker checks the shared
 *     `cancelled` flag BEFORE claiming its next item. Claiming
 *     (`nextIndex++`) and the check happen with no `await` between them, so
 *     — JavaScript being single-threaded/run-to-completion between awaits —
 *     two workers can never claim the same item, and once `cancelled`
 *     flips, no worker claims a further one.
 *
 * (b) **In-flight executions are allowed to settle; no unhandled
 *     rejections.** A worker that has already claimed an item keeps
 *     `await`-ing it to completion regardless of `cancelled`. Because every
 *     item's promise is awaited directly inside its own worker's
 *     `try/catch` — never handed off un-awaited, even when that worker's
 *     own catch block goes on to `queue.push()` more work — there is never
 *     a floating rejection for the runtime to report as
 *     `unhandledRejection`.
 *
 * (c) **Thrown error = lowest (origBatchIndex, origOffset) among discovered
 *     terminal errors.** Every worker that reaches a real terminal (no
 *     `recordTerminal`) pushes `{ batchIndex: origBatchIndex, callIndex:
 *     origOffset, error }`; once all workers finish, the lowest entry (by
 *     `compareTerminal`) is returned. For exactly one poisoned call this is
 *     deterministic regardless of timing/concurrency — bisection always
 *     eventually isolates it (or the cap forces a coarser but still unique
 *     terminal group) and it always settles. With two or more
 *     concurrently-failing regions, which one's error is thrown remains
 *     explicitly timing-dependent, same as T14.
 *
 * (d) **Results of in-flight items are discarded on cancel.** A write into
 *     the shared `results` array only happens `if (!cancelled)` at the
 *     moment an item settles — see `runSteps` in `src/core/engine.ts`, which
 *     throws immediately on a `cancelled` outcome instead of routing
 *     anything.
 *
 * **Result snapshot at settlement (T14, P1, preserved):** every write into
 * `results` clones the array AND every wrapper (`.map(r => ({...r}))`)
 * synchronously, with no `await` between it and the call that produced the
 * values — see T14's original reasoning, unchanged by bisection.
 *
 * **Backward-compatible signature:** `runBatchPool`'s first three parameters
 * are byte-identical to T14's (`batches`, `maxConcurrentBatches`, `execute`)
 * — `bisection` is a new, optional 4th parameter. Omitting it (or passing
 * `adaptive: false`) makes `canRetry` always false, so every rejection goes
 * straight to terminal on its FIRST occurrence — T14's exact behavior. This
 * is what lets every direct `runBatchPool(...)` call already in
 * `concurrency.test.ts` keep working, completely unmodified.
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
 * original batch index, then lowest call offset within that batch. Every
 * T14 terminal was whole-batch (`callIndex` always `0`), so this used to
 * degrade to plain `batchIndex` ordering; bisection (F6b) now feeds real
 * per-call offsets through the same 2-key comparator with no changes here.
 */
function compareTerminal(a: TerminalCandidate, b: TerminalCandidate): number {
  if (a.batchIndex !== b.batchIndex) return a.batchIndex - b.batchIndex
  return a.callIndex - b.callIndex
}

/** One unit of queued work — see the module doc's "The queue" section. */
interface WorkItem {
  calls: StepCall[]
  /** Which of the ORIGINAL `batches` these calls belong to. */
  origBatchIndex: number
  /** Offset of `calls[0]` within that original batch's full call list. */
  origOffset: number
}

/**
 * Adaptive-bisection configuration (F6b) — optional 4th argument to
 * `runBatchPool`. See the module doc's "Attempts accounting" and "Terminal
 * policy hook" sections.
 */
export interface BisectionPolicy {
  /** Enable split-and-retry on a batch-level rejection. `false` (or the
   *  whole `bisection` argument omitted) reproduces T14 exactly: any
   *  rejection is terminal on its first occurrence, `maxBatchAttempts` is
   *  never consulted. */
  adaptive: boolean
  /** Total executions allowed per ORIGINAL batch — enforced at claim time,
   *  covering the original's own first execution and every bisected child. */
  maxBatchAttempts: number
  /** Present only for a runner that never wants the whole pool cancelled on
   *  a terminal item (`runSettled`) — see the module doc's "Terminal policy
   *  hook" section. Absent means "cancel on terminal", exactly like T14. */
  recordTerminal?: (calls: StepCall[], error: unknown) => RawResult[]
}

/**
 * Dispatch `batches` through `execute` with at most `maxConcurrentBatches`
 * in flight at once, applying adaptive bisection (if `bisection?.adaptive`)
 * and fail-fast cancellation ((a)-(d) above) per the module doc comment.
 *
 * `maxConcurrentBatches` is clamped to `batches.length` — requesting more
 * workers than there are batches would just spin up idle workers that exit
 * immediately.
 */
export async function runBatchPool(
  batches: StepCall[][],
  maxConcurrentBatches: number,
  execute: (batch: StepCall[], batchIndex: number) => Promise<RawResult[]>,
  bisection?: BisectionPolicy,
): Promise<BatchPoolOutcome> {
  if (batches.length === 0) return { outcome: 'completed', results: [] }

  const adaptive = bisection?.adaptive ?? false
  const maxBatchAttempts = bisection?.maxBatchAttempts ?? Infinity
  const recordTerminal = bisection?.recordTerminal

  // Pre-sized PER ORIGINAL BATCH so bisected sub-batches can write into
  // their exact offset range. A never-split item covers the whole row
  // (offset 0, length === batches[i].length) — the same single write T14
  // did, in the same shape.
  const results: RawResult[][] = batches.map((b) => new Array<RawResult>(b.length))

  const queue: WorkItem[] = batches.map((calls, origBatchIndex) => ({ calls, origBatchIndex, origOffset: 0 }))

  const attempts: number[] = new Array(batches.length).fill(0)
  const lastError: unknown[] = new Array(batches.length)

  const terminalErrors: TerminalCandidate[] = []
  let nextIndex = 0
  let cancelled = false

  /** T14's fail-fast cancellation, generalized to a real (origBatchIndex,
   *  origOffset) pair instead of the always-0 callIndex T14 had. Used both
   *  for a genuine terminal (no `recordTerminal`) and, unconditionally, for
   *  the length-mismatch programmer-error case regardless of policy. */
  function cancelWith(origBatchIndex: number, origOffset: number, error: unknown): void {
    cancelled = true
    terminalErrors.push({ batchIndex: origBatchIndex, callIndex: origOffset, error })
  }

  function writeResults(item: WorkItem, batchResults: RawResult[]): void {
    if (cancelled) return
    // Snapshot (array AND each wrapper) at the moment of settlement — see
    // the module doc's "Result snapshot at settlement" note.
    const snapshot = batchResults.map((r): RawResult => ({ ...r }))
    const row = results[item.origBatchIndex]!
    for (let i = 0; i < snapshot.length; i++) {
      row[item.origOffset + i] = snapshot[i]!
    }
  }

  /** An item became terminal: a length-1 rejection, or its original batch's
   *  attempts cap exhausted before this item could even execute. */
  function handleTerminal(item: WorkItem, error: unknown): void {
    if (recordTerminal) {
      writeResults(item, recordTerminal(item.calls, error))
      return
    }
    cancelWith(item.origBatchIndex, item.origOffset, error)
  }

  async function worker(): Promise<void> {
    for (;;) {
      if (cancelled) return
      if (nextIndex >= queue.length) return
      const item = queue[nextIndex]!
      nextIndex++
      const { calls, origBatchIndex, origOffset } = item

      // Attempts cap (F6b) — checked at CLAIM time, before executing.
      if (attempts[origBatchIndex]! >= maxBatchAttempts) {
        handleTerminal(item, lastError[origBatchIndex])
        continue
      }
      attempts[origBatchIndex]!++

      try {
        const batchResults = await execute(calls, origBatchIndex)

        if (batchResults.length !== calls.length) {
          // Programmer-error path (executor-implementation bug): never
          // retried, never counted as a bisection-eligible transport
          // failure, aborts the run for BOTH runners regardless of
          // `recordTerminal` — see the module doc comment.
          cancelWith(
            origBatchIndex,
            origOffset,
            new Error(
              `StepExecutor returned ${batchResults.length} results for ${calls.length} calls — length mismatch`,
            ),
          )
          continue
        }

        writeResults(item, batchResults)
      } catch (error) {
        lastError[origBatchIndex] = error

        // External review (P1): re-check the cap HERE, synchronously, before
        // deciding to split — not just at each child's own future claim
        // time. If this execution already consumed the original's last
        // allowed attempt, pushing children would make this item's terminal
        // depend on a worker actually claiming them later — which never
        // happens once a *sibling* original's cancellation has already won
        // the race (see the module doc's "Attempts accounting" section).
        // Terminalizing THIS item immediately, covering its own full call
        // range, guarantees its error is recorded regardless of what any
        // concurrently in-flight item does.
        const attemptsRemain = attempts[origBatchIndex]! < maxBatchAttempts

        if (adaptive && calls.length > 1 && attemptsRemain) {
          // Bisection: split and retry both halves through this SAME
          // central queue — no recursive await. See the module doc's "The
          // queue" section for why this can never deadlock.
          const mid = Math.ceil(calls.length / 2)
          queue.push({ calls: calls.slice(0, mid), origBatchIndex, origOffset })
          queue.push({ calls: calls.slice(mid), origBatchIndex, origOffset: origOffset + mid })
        } else {
          handleTerminal(item, error)
        }
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
