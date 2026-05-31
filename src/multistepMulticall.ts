import type { Abi, Address, PublicClient } from "viem";

/**
 * A single on-chain call that belongs to one step of one task.
 */
export interface StepCall {
  /** Logical key for routing results back. */
  key: string;
  /** Target contract address. */
  target: Address;
  /** ABI for the contract (used by viem). */
  abi: Abi;
  /** Function name to call. */
  functionName: string;
  /** Raw arguments — validated at viem call-site, not here. */
  args?: readonly unknown[];
}

/**
 * Result of a single successful call.
 */
export interface StepResult {
  key: string;
  value: unknown;
}

/**
 * A self-contained task that describes a multi-step data retrieval pipeline.
 *
 * Conceptually:
 * - buildStepCalls(step) → calls needed for this step (may depend on prior results)
 * - consumeStepResults(step, results) → update internal state
 * - finalize() → collapse state into result type T
 *
 * Example (ERC4626 vault):
 * - Step 1: symbol, decimals, asset(), balanceOf(owner), maxWithdraw(owner), maxRedeem(owner)
 * - consumeStepResults: extract balance → update internal context
 * - Step 2: convertToAssets(balance) — uses step 1 result
 * - finalize: return { metadata, position }
 */
export interface MultistepTask<TResult> {
  /** Highest step index this task will use (1-based). */
  maxStep: number;

  /**
   * Build all calls needed for a given step.
   * Return empty array if this task has nothing to do for the step.
   */
  buildStepCalls(step: number): StepCall[];

  /**
   * Consume results for a given step and update internal task state.
   */
  consumeStepResults(step: number, results: StepResult[]): void;

  /**
   * Produce the final result once all steps are processed.
   */
  finalize(): TResult;
}

/**
 * Execute multiple MultistepTasks against a single PublicClient.
 *
 * Algorithm:
 * 1. Find maxStep across all tasks.
 * 2. For each step 1..maxStep:
 *    a. Build all calls from all tasks for this step.
 *    b. Batch into one multicall.
 *    c. Distribute results back to tasks by key.
 * 3. Call finalize() on all tasks and return results.
 *
 * Complexity: O(M) RPC calls where M = maxStep across all tasks.
 * (vs O(N) sequential calls for naive approach)
 */
export async function runMultistepTasks<TResult>(
  client: PublicClient,
  tasks: MultistepTask<TResult>[],
): Promise<TResult[]> {
  if (tasks.length === 0) return [];

  const maxStep = tasks.reduce(
    (max, task) => (task.maxStep > max ? task.maxStep : max),
    0,
  );

  for (let step = 1; step <= maxStep; step++) {
    const contracts: {
      address: Address;
      abi: Abi;
      functionName: string;
      args?: readonly unknown[];
    }[] = [];

    const mapping: { taskIndex: number; key: string }[] = [];

    for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
      const task = tasks[taskIndex]!;
      if (step > task.maxStep) continue;

      const calls = task.buildStepCalls(step);
      for (const call of calls) {
        contracts.push({
          address: call.target,
          abi: call.abi,
          functionName: call.functionName,
          args: call.args ?? [],
        });
        mapping.push({ taskIndex, key: call.key });
      }
    }

    if (contracts.length === 0) {
      continue;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await client.multicall({
      contracts: contracts as any,
      allowFailure: true,
      batchSize: 4 * 4096,
    });

    // Group results by task
    const perTaskResults = new Map<number, StepResult[]>();
    for (let i = 0; i < results.length; i++) {
      const entry = mapping[i];
      if (!entry) continue;
      const { taskIndex, key } = entry;
      const result = results[i] as any;

      if (result.status === "success") {
        let list = perTaskResults.get(taskIndex);
        if (!list) {
          list = [];
          perTaskResults.set(taskIndex, list);
        }
        list.push({ key, value: result.result });
      }
    }

    perTaskResults.forEach((resultsForTask, taskIndex) => {
      const task = tasks[taskIndex];
      if (task) {
        task.consumeStepResults(step, resultsForTask);
      }
    });
  }

  return tasks.map((task) => task.finalize());
}