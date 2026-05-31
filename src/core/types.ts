/**
 * Core types for the multistep-multicall library.
 *
 * MultistepTask is the framework-agnostic task description used by runMultistepTasks.
 * The actual execution is done by the viem PublicClient passed to runMultistepTasks.
 */

/**
 * A single on-chain call that belongs to one step of one task.
 */
export interface StepCall {
  /** Logical key for routing results back. */
  key: string;
  /** Target contract address. */
  target: `0x${string}`;
  /** ABI for the contract (used by viem). */
  abi: import("viem").Abi;
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
 */
/**
 * Abstraction over the underlying multicall execution engine.
 * Allows pluggable backends: viem, ethers v5, ethers v6, etc.
 */
export interface StepExecutor {
  executeMulticall(calls: StepCall[]): Promise<RawResult[]>;
}

/**
 * Raw result returned by StepExecutor.executeMulticall before routing.
 */
export interface RawResult {
  status: "success" | "failure";
  value?: unknown;
}

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
