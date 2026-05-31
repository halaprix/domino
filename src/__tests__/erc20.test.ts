import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveErc20Token, resolveErc20TokensBulk } from "../handlers/erc20";
import { erc20Abi } from "viem";

describe("resolveErc20Token", () => {
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      multicall: vi.fn(),
    };
  });

  it("resolves symbol and decimals without owner", async () => {
    mockClient.multicall.mockResolvedValueOnce([
      { status: "success", result: "USDC" },
      { status: "success", result: 6n },
    ]);

    const result = await resolveErc20Token({
      client: mockClient,
      token: "0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4",
    });

    expect(result.symbol).toBe("USDC");
    expect(result.decimals).toBe(6);
    expect(result.balance).toBeUndefined();
  });

  it("resolves symbol, decimals, and balance with owner", async () => {
    // Single step: symbol, decimals, balanceOf
    mockClient.multicall.mockResolvedValueOnce([
      { status: "success", result: "USDC" },
      { status: "success", result: 6n },
      { status: "success", result: 1000000n },
    ]);

    const result = await resolveErc20Token({
      client: mockClient,
      token: "0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4",
      owner: "0x1234567890123456789012345678901234567890",
    });

    expect(result.symbol).toBe("USDC");
    expect(result.decimals).toBe(6);
    expect(result.balance).toBe(1000000n);
  });
});

describe("resolveErc20TokensBulk", () => {
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      multicall: vi.fn(),
    };
  });

  it("resolves multiple tokens in one multicall", async () => {
    // All tasks batched into single step 1
    mockClient.multicall.mockResolvedValueOnce([
      // Token 0
      { status: "success", result: "USDC" },
      { status: "success", result: 6n },
      { status: "success", result: 1000000n },
      // Token 1
      { status: "success", result: "WETH" },
      { status: "success", result: 18n },
      { status: "success", result: 2000000000000000000n },
    ]);

    const results = await resolveErc20TokensBulk({
      client: mockClient,
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
    // Single multicall call for 6 contract calls
    expect(mockClient.multicall).toHaveBeenCalledTimes(1);
  });

  it("returns empty array for empty entries", async () => {
    const results = await resolveErc20TokensBulk({
      client: mockClient,
      entries: [],
    });
    expect(results).toEqual([]);
    expect(mockClient.multicall).not.toHaveBeenCalled();
  });
});
