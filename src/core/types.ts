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
  key: string
  /** Target contract address. */
  target: Address
  /** ABI for the contract (used by viem). */
  abi: readonly unknown[]
  /** Function name to call. */
  functionName: string
  /** Raw arguments : validated at viem call-site, not here. */
  args?: readonly unknown[]
}

/** Valid hex address string. */
export type Address = `0x${string}`

/**
 * Result of a single successful call.
 */
export interface StepResult {
  key: string
  value: unknown
  /** 'failure' if the call reverted; omitted when it succeeded. */
  status?: 'failure'
}

/**
 * Abstraction over the underlying multicall execution engine.
 * Allows pluggable backends: viem, ethers v5, ethers v6, etc.
 */
export interface StepExecutor {
  executeMulticall(calls: StepCall[]): Promise<RawResult[]>
}

/**
 * Raw result returned by StepExecutor.executeMulticall before routing.
 */
export interface RawResult {
  status: 'success' | 'failure'
  value?: unknown
}

/**
 * A self-contained task that describes a multi-step data retrieval pipeline.
 * The task's buildStepCalls, consumeStepResults, and finalize are called
 * by runMultistepTasks in step order.
 */
export interface MultistepTask<TResult> {
  /** Highest step index this task will use (1-based). */
  maxStep: number

  /**
   * Build all calls needed for a given step.
   * Return empty array if this task has nothing to do for the step.
   */
  buildStepCalls(step: number): StepCall[]

  /**
   * Consume results for a given step and update internal task state.
   */
  consumeStepResults(step: number, results: StepResult[]): void

  /**
   * Produce the final result once all steps are processed.
   */
  finalize(): TResult
}
