import { describe, it, expect, vi, beforeEach } from "vitest";
import { runMultistepTasks } from "../multistepMulticall";
import type { MultistepTask } from "../multistepMulticall";

describe("runMultistepTasks", () => {
  // Mock viem PublicClient
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      multicall: vi.fn(),
    };
  });

  it("executes single-step task and returns result", async () => {
    const task: MultistepTask<{ value: string }> = {
      maxStep: 1,
      buildStepCalls: (step) => {
        if (step !== 1) return [];
        return [
          {
            key: "value",
            target: "0x1234567890123456789012345678901234567890",
            abi: [{ type: "function", name: "symbol", inputs: [], outputs: [{ type: "string" }] }],
            functionName: "symbol",
          },
        ];
      },
      consumeStepResults: () => {},
      finalize: () => ({ value: "TKN" }),
    };

    mockClient.multicall.mockResolvedValueOnce([
      { status: "success", result: "TKN" },
    ]);

    const results = await runMultistepTasks(mockClient, [task]);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ value: "TKN" });
  });

  it("routes results to tasks by key", async () => {
    const taskA: MultistepTask<{ a: string }> = {
      maxStep: 1,
      buildStepCalls: (step) => {
        if (step !== 1) return [];
        return [
          {
            key: "a",
            target: "0x1111111111111111111111111111111111111111",
            abi: [{ type: "function", name: "symbol", inputs: [], outputs: [{ type: "string" }] }],
            functionName: "symbol",
          },
        ];
      },
      consumeStepResults: vi.fn(),
      finalize: () => ({ a: "A" }),
    };

    const taskB: MultistepTask<{ b: string }> = {
      maxStep: 1,
      buildStepCalls: (step) => {
        if (step !== 1) return [];
        return [
          {
            key: "b",
            target: "0x2222222222222222222222222222222222222222",
            abi: [{ type: "function", name: "symbol", inputs: [], outputs: [{ type: "string" }] }],
            functionName: "symbol",
          },
        ];
      },
      consumeStepResults: vi.fn(),
      finalize: () => ({ b: "B" }),
    };

    mockClient.multicall.mockResolvedValueOnce([
      { status: "success", result: "A" },
      { status: "success", result: "B" },
    ]);

    const results = await runMultistepTasks(mockClient, [taskA, taskB]);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ a: "A" });
    expect(results[1]).toEqual({ b: "B" });
  });

  it("executes multi-step task: step2 depends on step1 results", async () => {
    let capturedBalance: bigint | undefined;
    let capturedAssets: bigint | undefined;

    const task: MultistepTask<{ shares: bigint; assets: bigint }> = {
      maxStep: 2,
      buildStepCalls: (step) => {
        if (step === 1) {
          return [
            {
              key: "balance",
              target: "0x3333333333333333333333333333333333333333",
              abi: [{ type: "function", name: "balanceOf", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] }],
              functionName: "balanceOf",
              args: ["0x4444444444444444444444444444444444444444"],
            },
          ];
        }
        if (step === 2 && capturedBalance !== undefined) {
          return [
            {
              key: "assets",
              target: "0x3333333333333333333333333333333333333333",
              abi: [{ type: "function", name: "convertToAssets", inputs: [{ name: "shares", type: "uint256" }], outputs: [{ type: "uint256" }] }],
              functionName: "convertToAssets",
              args: [capturedBalance],
            },
          ];
        }
        return [];
      },
      consumeStepResults: (step, results) => {
        if (step === 1) {
          for (const r of results) {
            if (r.key === "balance") {
              capturedBalance = r.value as bigint;
            }
          }
        }
        if (step === 2) {
          for (const r of results) {
            if (r.key === "assets") {
              capturedAssets = r.value as bigint;
            }
          }
        }
      },
      finalize: () => ({ shares: capturedBalance ?? 0n, assets: capturedAssets ?? 0n }),
    };

    // Step 1 response
    mockClient.multicall.mockResolvedValueOnce([
      { status: "success", result: 1000000000000000000n },
    ]);
    // Step 2 response
    mockClient.multicall.mockResolvedValueOnce([
      { status: "success", result: 1500000000000000000n },
    ]);

    const results = await runMultistepTasks(mockClient, [task]);
    expect(results).toHaveLength(1);
    expect(results[0].shares).toBe(1000000000000000000n);
    expect(results[0].assets).toBe(1500000000000000000n);
    // Verify multicall was called twice (once per step)
    expect(mockClient.multicall).toHaveBeenCalledTimes(2);
  });

  it("returns empty array for empty tasks", async () => {
    const results = await runMultistepTasks(mockClient, []);
    expect(results).toEqual([]);
  });

  it("skips failed calls (allowFailure) and continues", async () => {
    const task: MultistepTask<{ value: string | undefined }> = {
      maxStep: 1,
      buildStepCalls: (step) => {
        if (step !== 1) return [];
        return [
          {
            key: "value",
            target: "0x5555555555555555555555555555555555555555",
            abi: [{ type: "function", name: "symbol", inputs: [], outputs: [{ type: "string" }] }],
            functionName: "symbol",
          },
        ];
      },
      consumeStepResults: () => {},
      finalize: () => ({ value: undefined }),
    };

    // Simulate allowFailure: call returns error object
    mockClient.multicall.mockResolvedValueOnce([
      { status: "failure", error: "Execution reverted" },
    ]);

    const results = await runMultistepTasks(mockClient, [task]);
    expect(results).toHaveLength(1);
    // Failed calls are skipped, consumeStepResults not called, finalize receives empty results
    expect(results[0]).toEqual({ value: undefined });
  });
});