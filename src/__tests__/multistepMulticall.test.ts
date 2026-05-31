import { describe, it, expect, vi } from "vitest";
import { runMultistepTasks } from "../core/runMultistepTasks";
import type { MultistepTask, StepCall, StepResult, StepExecutor } from "../core/types";

describe("runMultistepTasks", () => {
  it("executes single-step task and returns result", async () => {
    const mockExecutor: StepExecutor = {
      async executeMulticall(_calls: StepCall[]): Promise<any[]> {
        return [
          { status: "success", value: "USDC" },
          { status: "success", value: 6n },
        ];
      },
    };

    const task: MultistepTask<{ symbol: string; decimals: number }> = {
      maxStep: 1,
      buildStepCalls(step) {
        if (step !== 1) return [];
        return [
          { key: "symbol", target: "0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4", abi: [], functionName: "symbol" },
          { key: "decimals", target: "0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4", abi: [], functionName: "decimals" },
        ];
      },
      consumeStepResults(_step, results) {
        // no-op
      },
      finalize() {
        return { symbol: "USDC", decimals: 6 };
      },
    };

    const [result] = await runMultistepTasks(mockExecutor, [task]);
    expect(result.symbol).toBe("USDC");
    expect(result.decimals).toBe(6);
  });

  it("routes results to tasks by key", async () => {
    const mockExecutor: StepExecutor = {
      async executeMulticall(_calls: StepCall[]): Promise<any[]> {
        return [
          { status: "success", value: "TOK1" },
          { status: "success", value: 18 },
          { status: "success", value: "TOK2" },
          { status: "success", value: 8 },
        ];
      },
    };

    const task1: MultistepTask<{ symbol: string; decimals: number }> = {
      maxStep: 1,
      buildStepCalls(step) {
        if (step !== 1) return [];
        return [
          { key: "symbol", target: "0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4", abi: [], functionName: "symbol" },
          { key: "decimals", target: "0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4", abi: [], functionName: "decimals" },
        ];
      },
      consumeStepResults() {},
      finalize() {
        return { symbol: "TOK1", decimals: 18 };
      },
    };

    const task2: MultistepTask<{ symbol: string; decimals: number }> = {
      maxStep: 1,
      buildStepCalls(step) {
        if (step !== 1) return [];
        return [
          { key: "symbol", target: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", abi: [], functionName: "symbol" },
          { key: "decimals", target: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", abi: [], functionName: "decimals" },
        ];
      },
      consumeStepResults() {},
      finalize() {
        return { symbol: "TOK2", decimals: 8 };
      },
    };

    const [result1, result2] = await runMultistepTasks(mockExecutor, [task1, task2]);
    expect(result1.symbol).toBe("TOK1");
    expect(result1.decimals).toBe(18);
    expect(result2.symbol).toBe("TOK2");
    expect(result2.decimals).toBe(8);
  });

  it("executes multi-step task: step2 depends on step1 results", async () => {
    let capturedBalance: bigint | undefined;

    const mockExecutor: StepExecutor = {
      async executeMulticall(calls: StepCall[]): Promise<any[]> {
        // Step 1 returns balance
        if (calls[0]?.key === "balance") {
          return [{ status: "success", value: 1000n }];
        }
        // Step 2 uses captured balance
        return [{ status: "success", value: 999n }];
      },
    };

    const task: MultistepTask<{ balance: bigint; assets: bigint }> = {
      maxStep: 2,
      buildStepCalls(step) {
        if (step === 1) {
          return [
            { key: "balance", target: "0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4", abi: [], functionName: "balanceOf" },
          ];
        }
        if (step === 2 && capturedBalance !== undefined) {
          return [
            { key: "assets", target: "0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4", abi: [], functionName: "convertToAssets", args: [capturedBalance] },
          ];
        }
        return [];
      },
      consumeStepResults(step, results) {
        if (step === 1) {
          capturedBalance = results.find(r => r.key === "balance")?.value as bigint;
        }
      },
      finalize() {
        return { balance: capturedBalance!, assets: 999n };
      },
    };

    const [result] = await runMultistepTasks(mockExecutor, [task]);
    expect(result.balance).toBe(1000n);
    expect(result.assets).toBe(999n);
  });

  it("skips failed calls (allowFailure) and continues", async () => {
    const mockExecutor: StepExecutor = {
      async executeMulticall(_calls: StepCall[]): Promise<any[]> {
        return [
          { status: "failure", value: undefined },
          { status: "success", value: 6n },
        ];
      },
    };

    const task: MultistepTask<{ symbol: string | undefined; decimals: number }> = {
      maxStep: 1,
      buildStepCalls(step) {
        if (step !== 1) return [];
        return [
          { key: "symbol", target: "0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4", abi: [], functionName: "symbol" },
          { key: "decimals", target: "0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4", abi: [], functionName: "decimals" },
        ];
      },
      consumeStepResults() {},
      finalize() {
        return { symbol: undefined, decimals: 6 };
      },
    };

    const [result] = await runMultistepTasks(mockExecutor, [task]);
    expect(result.symbol).toBeUndefined();
    expect(result.decimals).toBe(6);
  });
});
