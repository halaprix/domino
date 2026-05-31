import type { Abi, Address, PublicClient } from "viem";

export interface StepCall {
  key: string;
  target: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

export interface StepResult {
  key: string;
  value: unknown;
}

export interface MultistepTask<TResult> {
  maxStep: number;
  buildStepCalls(step: number): StepCall[];
  consumeStepResults(step: number, results: StepResult[]): void;
  finalize(): TResult;
}

export async function runMultistepTasks<TResult>(
  _client: PublicClient,
  tasks: MultistepTask<TResult>[],
): Promise<TResult[]> {
  void _client;
  void tasks;
  throw new Error("Not yet implemented");
}
