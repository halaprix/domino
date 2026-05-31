import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveErc20Token, resolveErc20TokensBulk } from "../handlers/erc20";
import type { RawResult } from "../core/types";

describe("resolveErc20Token", () => {
  let mockExecutor: { executeMulticall: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockExecutor = {
      executeMulticall: vi.fn(),
    };
  });

  it("resolves symbol and decimals without owner", async () => {
    // StepExecutor.executeMulticall returns RawResult[]: { status, value? }[]
    mockExecutor.executeMulticall.mockResolvedValueOnce([
      { status: "success", value: "USDC" },
      { status: "success", value: 6n },
    ] as RawResult[]);

    const result = await resolveErc20Token({
      client: mockExecutor as any,
      token: "0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4",
    } as any);

    expect(result.symbol).toBe("USDC");
    expect(result.decimals).toBe(6);
    expect(result.balance).toBeUndefined();
  });

  it("resolves symbol, decimals, and balance with owner", async () => {
    mockExecutor.executeMulticall.mockResolvedValueOnce([
      { status: "success", value: "USDC" },
      { status: "success", value: 6n },
      { status: "success", value: "1000000" },
    ] as RawResult[]);

    const result = await resolveErc20Token({
      client: mockExecutor as any,
      token: "0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4",
      owner: "0x1234567890123456789012345678901234567890",
    } as any);

    expect(result.symbol).toBe("USDC");
    expect(result.decimals).toBe(6);
    expect(result.balance).toBe(1000000n);
  });
});

describe("resolveErc20TokensBulk", () => {
  let mockExecutor: { executeMulticall: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockExecutor = {
      executeMulticall: vi.fn(),
    };
  });

  it("resolves multiple tokens in one multicall", async () => {
    // All tasks batched into single step 1
    mockExecutor.executeMulticall.mockResolvedValueOnce([
      // Token 0
      { status: "success", value: "USDC" },
      { status: "success", value: 6n },
      { status: "success", value: "1000000" },
      // Token 1
      { status: "success", value: "WETH" },
      { status: "success", value: 18n },
      { status: "success", value: "2000000000000000000" },
    ] as RawResult[]);

    const results = await resolveErc20TokensBulk({
      client: mockExecutor as any,
      entries: [
        {
          token: "0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4",
          owner: "0x1234567890123456789012345678901234567890",
        },
        {
          token: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
          owner: "0x1234567890123456789012345678901234567890",
        },
      ],
    });

    expect(results).toHaveLength(2);
    expect(results[0]?.symbol).toBe("USDC");
    expect(results[0]?.balance).toBe(1000000n);
    expect(results[1]?.symbol).toBe("WETH");
    expect(results[1]?.balance).toBe(2000000000000000000n);
    // Single executeMulticall call for 6 contract calls
    expect(mockExecutor.executeMulticall).toHaveBeenCalledTimes(1);
  });

  it("returns empty array for empty entries", async () => {
    const results = await resolveErc20TokensBulk({
      client: mockExecutor as any,
      entries: [],
    });
    expect(results).toEqual([]);
    expect(mockExecutor.executeMulticall).not.toHaveBeenCalled();
  });
});
