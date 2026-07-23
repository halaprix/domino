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

import type { MultistepTask, StepExecutor, RawResult, Address } from './types'
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
  const { batchSize, maxConcurrentBatches } = prepareRun(ts, options)

  if (ts.length === 0) return []

  await resolvePinnedBlock()

  // Dead-task bookkeeping: once true, no further buildStepCalls/consumeStepResults
  // calls happen for that task index, and finalize() is skipped entirely.
  // Lives here (not in the shared engine) — it's `runSettled`-specific state
  // that its policy hooks close over; the engine never sees it directly.
  const dead: boolean[] = new Array(ts.length).fill(false)
  const deadError: unknown[] = new Array(ts.length)

  // `runSettled`'s record-and-continue policy (F6a) — see
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
      let results: RawResult[]
      try {
        results = await executor.executeMulticall(batch, options?.block)
      } catch (transportError) {
        // Batch-level failure: every call in THIS physical batch fails with
        // its own DominoCallError, all sharing the SAME cause. Resolve
        // (never reject) — this is what makes `runSettled` never cancel:
        // `runBatchPool`'s fail-fast machinery only triggers on a REJECTION
        // from this hook, and an ordinary transport failure never produces
        // one here. Later batches/steps still execute.
        return batch.map(
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
      // rejects this hook, which aborts `runSettled` entirely (via the
      // pool's ordinary fail-fast path) same as an invalid batchSize.
      if (results.length !== batch.length) {
        throw new Error(
          `StepExecutor returned ${results.length} results for ${batch.length} calls — length mismatch`,
        )
      }
      return results
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

  await runSteps(ts, { batchSize, maxConcurrentBatches }, policy)

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
