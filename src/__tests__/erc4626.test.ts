import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveErc4626Vault, resolveErc4626VaultsBulk } from "../handlers/erc4626";

describe("resolveErc4626Vault", () => {
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      multicall: vi.fn(),
    };
  });

  it("resolves metadata only (no owner)", async () => {
    // Step 1: symbol, decimals, asset
    mockClient.multicall.mockResolvedValueOnce([
      { status: "success", result: "ankrETH" },
      { status: "success", result: 18n },
      { status: "success", result: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" },
    ]);

    const result = await resolveErc4626Vault({
      client: mockClient,
      vault: "0x0000000000000000000000000000000000000001",
    });

    expect(result.metadata.symbol).toBe("ankrETH");
    expect(result.metadata.decimals).toBe(18);
    expect(result.metadata.underlyingAsset).toBe("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
    expect(result.position).toBeUndefined();
  });

  it("resolves metadata + position with owner (2-step)", async () => {
    // Step 1: symbol, decimals, asset, balanceOf, maxWithdraw, maxRedeem
    mockClient.multicall.mockResolvedValueOnce([
      { status: "success", result: "ankrETH" },
      { status: "success", result: 18n },
      { status: "success", result: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" },
      { status: "success", result: 1000000000000000000n }, // 1 share
      { status: "success", result: 1600000000000000000n },   // maxWithdraw
      { status: "success", result: 1000000000000000000n },   // maxRedeem
    ]);
    // Step 2: convertToAssets(1000000000000000000n) — uses step 1 balance
    mockClient.multicall.mockResolvedValueOnce([
      { status: "success", result: 1500000000000000000n }, // 1.5 ETH underlying
    ]);

    const result = await resolveErc4626Vault({
      client: mockClient,
      vault: "0x0000000000000000000000000000000000000001",
      owner: "0x1234567890123456789012345678901234567890",
    });

    expect(result.metadata.symbol).toBe("ankrETH");
    expect(result.metadata.underlyingAsset).toBe("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
    expect(result.position?.balance).toBe(1000000000000000000n);
    expect(result.position?.assets).toBe(1500000000000000000n);
    // Two multicall calls: step 1 and step 2
    expect(mockClient.multicall).toHaveBeenCalledTimes(2);
  });

  it("skips step 2 when balance is undefined", async () => {
    // Step 1 returns no balance (e.g. user has no position)
    mockClient.multicall.mockResolvedValueOnce([
      { status: "success", result: "ankrETH" },
      { status: "success", result: 18n },
      { status: "success", result: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" },
    ]);
    // No balance call, so step 2 buildStepCalls returns empty → no second multicall

    const result = await resolveErc4626Vault({
      client: mockClient,
      vault: "0x0000000000000000000000000000000000000001",
      owner: "0x1234567890123456789012345678901234567890",
    });

    expect(result.metadata.symbol).toBe("ankrETH");
    expect(result.position?.balance).toBeUndefined();
    expect(result.position?.assets).toBeUndefined();
    // Only step 1 was executed
    expect(mockClient.multicall).toHaveBeenCalledTimes(1);
  });
});

describe("resolveErc4626VaultsBulk", () => {
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      multicall: vi.fn(),
    };
  });

  it("batches step 1 and step 2 for all vaults into two multicalls", async () => {
    // Step 1: all vaults' symbol/decimals/asset/balance/maxWithdraw/maxRedeem
    mockClient.multicall.mockResolvedValueOnce([
      // Vault 0
      { status: "success", result: "ankrETH" },
      { status: "success", result: 18n },
      { status: "success", result: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" },
      { status: "success", result: 1000000000000000000n },
      { status: "success", result: 1500000000000000000n },
      { status: "success", result: 1000000000000000000n },
      // Vault 1
      { status: "success", result: "stETH" },
      { status: "success", result: 18n },
      { status: "success", result: "0xAE7ab96520DE3A6E5f16f0f3345D4C3F053ACb1FC" },
      { status: "success", result: 2000000000000000000n },
      { status: "success", result: 3100000000000000000n },
      { status: "success", result: 2000000000000000000n },
    ]);
    // Step 2: all vaults' convertToAssets(balance)
    mockClient.multicall.mockResolvedValueOnce([
      { status: "success", result: 1500000000000000000n },
      { status: "success", result: 3100000000000000000n },
    ]);

    const results = await resolveErc4626VaultsBulk({
      client: mockClient,
      entries: [
        {
          vault: "0x0000000000000000000000000000000000000001",
          owner: "0x1234567890123456789012345678901234567890",
        },
        {
          vault: "0x0000000000000000000000000000000000000002",
          owner: "0x1234567890123456789012345678901234567890",
        },
      ],
    });

    expect(results).toHaveLength(2);
    expect(results[0]?.metadata.symbol).toBe("ankrETH");
    expect(results[0]?.position?.assets).toBe(1500000000000000000n);
    expect(results[1]?.metadata.symbol).toBe("stETH");
    expect(results[1]?.position?.assets).toBe(3100000000000000000n);
    // 2 multicall calls total: one for step 1, one for step 2
    expect(mockClient.multicall).toHaveBeenCalledTimes(2);
  });

  it("returns empty array for empty entries", async () => {
    const results = await resolveErc4626VaultsBulk({
      client: mockClient,
      entries: [],
    });
    expect(results).toEqual([]);
  });
});