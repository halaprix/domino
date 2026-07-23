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
 * **Adaptive bisection (F6b, `options.adaptiveBatching`):** with it OFF
 * (default), the paragraph above is the WHOLE story, byte-for-byte unchanged
 * from F5/1.1 — `executeBatch` catches every ordinary transport rejection
 * itself and resolves with synthesized failures, so the pool
 * (`src/core/pool.ts`) never even observes one. With it ON, `executeBatch`
 * deliberately lets a transport rejection propagate to the pool instead of
 * catching it, so the pool's bisection can split a `length > 1` batch and
 * retry both halves. The per-call `DominoCallError` synthesis above still
 * happens — just once per TERMINAL sub-batch (a single-call rejection, or
 * the attempts cap exhausted for that original batch) via the
 * `recordTerminal` policy hook below, instead of once per whole-batch
 * rejection. Either way, the run never cancels on an ordinary transport
 * failure: siblings, other steps, and other tasks keep going.
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

import type { MultistepTask, StepExecutor, StepCall, RawResult, Address } from './types'
import type { BatchOptions } from './runMultistepTasks'
import { DominoCallError } from './errors'
import { prepareRun, resolvePinnedBlock } from './internal'
import { runSteps, type StepEnginePolicy } from './engine'

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
 * Synthesize one `DominoCallError` (`kind: 'batch'`) per call, all sharing
 * the SAME `cause` — the transport error that failed the physical batch (or
 * bisected sub-batch, or coarse terminal group) these calls belong to. Used
 * from two call sites that must stay provably identical: the non-adaptive
 * `executeBatch` catch branch (whole-batch failure, T14 shape) and the
 * adaptive `recordTerminal` policy hook (per-terminal-item failure, F6b) —
 * factoring this out is what proves they produce the exact same shape.
 */
function synthesizeBatchFailures(calls: StepCall[], transportError: unknown): RawResult[] {
  return calls.map(
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
 * bug in the executor, not a call failure) — the length-mismatch guard lives
 * in the pool itself (`src/core/pool.ts`), applied uniformly to `run` and
 * `runSettled`, and never retried even when `adaptiveBatching` is on.
 */
export async function runSettled<TResult>(
  executor: StepExecutor,
  tasks: MultistepTask<TResult>[],
  options?: BatchOptions,
): Promise<SettledTaskResult<TResult>[]> {
  // TOCTOU fix (external review, P1): snapshot the caller-owned array BEFORE
  // the consumption pipeline runs, and read ONLY this snapshot (`ts`) for
  // everything from here on — never `tasks` again. See the identical
  // comment in `runMultistepTasks` for the full attack this closes; the
  // snapshot must happen before `prepareRun`, not just before the `await`
  // below, so `prepareRun` itself marks/validates the SAME array every
  // subsequent read uses.
  const ts = tasks.slice()

  // F2 consumption pipeline (validate -> reject-duplicates -> pin-capability
  // -> mark-consumed), see `src/core/internal.ts`. Validation is a
  // programmer error and must throw regardless of whether there happen to
  // be any tasks — checked BEFORE the empty-tasks shortcut so
  // `runSettled(executor, [], { batchSize: 0 })` rejects rather than
  // silently resolving to `[]` (unchanged 1.0 ordering — contrast with
  // `runMultistepTasks`, which checks the empty-tasks shortcut first).
  const { batchSize, maxConcurrentBatches, adaptiveBatching, maxBatchAttempts } = prepareRun(ts, options)

  if (ts.length === 0) return []

  await resolvePinnedBlock()

  // Dead-task bookkeeping: once true, no further buildStepCalls/consumeStepResults
  // calls happen for that task index, and finalize() is skipped entirely.
  // Lives here (not in the shared engine) — it's `runSettled`-specific state
  // that its policy hooks close over; the engine never sees it directly.
  const dead: boolean[] = new Array(ts.length).fill(false)
  const deadError: unknown[] = new Array(ts.length)

  // `runSettled`'s record-and-continue policy (F6a/F6b) — see
  // `src/core/engine.ts`'s doc comment for the full hook contract.
  const policy: StepEnginePolicy = {
    buildStepCalls(taskIndex, step) {
      if (dead[taskIndex]) return undefined
      const task = ts[taskIndex]!
      if (step > task.maxStep) return undefined
      try {
        return task.buildStepCalls(step)
      } catch (err) {
        dead[taskIndex] = true
        deadError[taskIndex] = err
        return undefined
      }
    },

    async executeBatch(batch) {
      if (adaptiveBatching) {
        // F6b: let a transport rejection propagate to the pool so its
        // bisection can split this batch and retry both halves — the T14
        // catch-and-resolve-immediately behavior below would otherwise hide
        // the rejection from the pool entirely, and bisection could never
        // engage. The per-call `DominoCallError` synthesis still happens —
        // once per TERMINAL sub-batch, via `recordTerminal` below, instead
        // of once per whole-batch rejection here. The length-mismatch guard
        // (a programmer error, never a transport failure) lives in the pool
        // itself now — see `src/core/pool.ts` — so it applies uniformly to
        // this call whether the pool handed it a whole batch or a bisected
        // sub-batch.
        return executor.executeMulticall(batch, options?.block)
      }

      // Adaptive OFF (default) — byte-for-byte T14/F5 behavior: catch a
      // transport rejection here and RESOLVE with synthesized per-call
      // failures instead of letting it reach the pool. This is what makes
      // `runSettled` never cancel by default: `runBatchPool`'s fail-fast
      // machinery only triggers on a REJECTION from this hook, and an
      // ordinary transport failure never produces one here. Later
      // batches/steps still execute. (The length-mismatch guard is likewise
      // now the pool's job — see `executeBatch` above and `pool.ts` — so
      // this branch, like the adaptive one, is just the raw executor call.)
      try {
        return await executor.executeMulticall(batch, options?.block)
      } catch (transportError) {
        return synthesizeBatchFailures(batch, transportError)
      }
    },

    // F6b — adaptive bisection's terminal hook: called once per terminal
    // sub-batch (a single-call rejection, or the attempts cap exhausted for
    // its original batch) instead of the whole-batch catch above. Same
    // synthesis, same shape, proven identical by sharing the one helper.
    // Never invoked when `adaptiveBatching` is off (no rejection ever
    // reaches the pool from `executeBatch` above in that case, except the
    // length-mismatch bug, which bypasses this hook entirely and aborts —
    // see `pool.ts`).
    recordTerminal(calls, error) {
      return synthesizeBatchFailures(calls, error)
    },

    consumeStepResults(taskIndex, step, results) {
      if (dead[taskIndex]) return
      const task = ts[taskIndex]
      if (task && step <= task.maxStep) {
        try {
          task.consumeStepResults(step, results)
        } catch (err) {
          dead[taskIndex] = true
          deadError[taskIndex] = err
        }
      }
    },
  }

  await runSteps(ts, { batchSize, maxConcurrentBatches, adaptiveBatching, maxBatchAttempts }, policy)

  return ts.map((task, i): SettledTaskResult<TResult> => {
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
