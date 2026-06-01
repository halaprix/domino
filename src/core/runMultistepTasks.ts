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

import type { MultistepTask, StepCall, StepResult, StepExecutor, RawResult } from './types'

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
}

/**
 * Execute multiple MultistepTasks against a single StepExecutor.
 *
 * @param executor - Framework-specific multicall executor (viem, ethers, etc.)
 * @param tasks - Array of MultistepTask instances
 * @param options - Optional batching options
 * @returns Array of finalized results in same order as input tasks
 */
export async function runMultistepTasks<TResult>(
  executor: StepExecutor,
  tasks: MultistepTask<TResult>[],
  options?: BatchOptions,
): Promise<TResult[]> {
  if (tasks.length === 0) return []

  const maxStep = tasks.reduce((max, task) => (task.maxStep > max ? task.maxStep : max), 0)
  const batchSize = options?.batchSize ?? 100
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`batchSize must be a positive integer, got ${batchSize}`)
  }

  for (let step = 1; step <= maxStep; step++) {
    const calls: StepCall[] = []
    const mapping: { taskIndex: number; key: string }[] = []

    for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
      const task = tasks[taskIndex]!
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
    const perTaskResults: StepResult[][] = Array.from({ length: tasks.length }, () => [])

    // Only hit the network when there are calls; a step where every active task
    // built nothing still dispatches empty results below (consistent per-step
    // notification regardless of sibling tasks).
    if (calls.length > 0) {
      // Split calls into batches to stay under per-call gas limits.
      // Each batch executes as a separate multicall round-trip.
      for (let batchStart = 0; batchStart < calls.length; batchStart += batchSize) {
        const batch = calls.slice(batchStart, batchStart + batchSize)
        const results = await executor.executeMulticall(batch)

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
            list.push({ status: 'failure', key })
          }
        }
      }
    }

    // Dispatch to every task active at this step — including those that built no
    // calls — so consumeStepResults is invoked consistently each step.
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i]
      if (task && step <= task.maxStep) {
        task.consumeStepResults(step, perTaskResults[i]!)
      }
    }
  }

  return tasks.map((task) => task.finalize())
}

export type { StepExecutor, StepCall, StepResult, RawResult }