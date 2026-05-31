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
 * Execute multiple MultistepTasks against a single StepExecutor.
 *
 * @param executor - Framework-specific multicall executor (viem, ethers, etc.)
 * @param tasks - Array of MultistepTask instances
 * @returns Array of finalized results in same order as input tasks
 */
export async function runMultistepTasks<TResult>(
  executor: StepExecutor,
  tasks: MultistepTask<TResult>[],
): Promise<TResult[]> {
  if (tasks.length === 0) return []

  const maxStep = tasks.reduce((max, task) => (task.maxStep > max ? task.maxStep : max), 0)

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

    if (calls.length === 0) {
      continue
    }

    const results = await executor.executeMulticall(calls)

    // Group results by task
    const perTaskResults = new Map<number, StepResult[]>()
    for (let i = 0; i < results.length; i++) {
      const entry = mapping[i]
      if (!entry) continue
      const { taskIndex, key } = entry
      const result = results[i] as RawResult

      if (result.status === 'success') {
        let list = perTaskResults.get(taskIndex)
        if (!list) {
          list = []
          perTaskResults.set(taskIndex, list)
        }
        list.push({ key, value: result.value })
      }
    }

    perTaskResults.forEach((resultsForTask, taskIndex) => {
      const task = tasks[taskIndex]
      if (task) {
        task.consumeStepResults(step, resultsForTask)
      }
    })
  }

  return tasks.map((task) => task.finalize())
}

export type { StepExecutor, StepCall, StepResult, RawResult }
