import { describe, it, expect, vi } from "vitest";
import { resolveErc4626Vault, resolveErc4626VaultsBulk } from "../handlers/erc4626";
import { runMultistepTasks } from "../core/runMultistepTasks";

vi.mock("../core/runMultistepTasks", () => ({
  runMultistepTasks: vi.fn(),
}));

describe("resolveErc4626Vault", () => {
  it("resolves metadata only (no owner)", async () => {
    (runMultistepTasks as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{
      metadata: {
        symbol: "wstETH",
        decimals: 18,
        underlyingAsset: "0xae7ab96520de3a18e5e111b5eaab095312d7fe84",
        maxWithdraw: undefined,
        maxRedeem: undefined,
      },
      position: undefined,
    }]);

    const result = await resolveErc4626Vault({
      client: {} as any,
      vault: "0xae7ab96520de3a18e5e111b5eaab095312d7fe84",
      owner: undefined,
    });

    expect(result.metadata.symbol).toBe("wstETH");
    expect(result.metadata.decimals).toBe(18);
    expect(result.metadata.underlyingAsset).toBe("0xae7ab96520de3a18e5e111b5eaab095312d7fe84");
    expect(result.position).toBeUndefined();
  });

  it("resolves metadata + position with owner (2-step)", async () => {
    (runMultistepTasks as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{
      metadata: {
        symbol: "wstETH",
        decimals: 18,
        underlyingAsset: "0xae7ab96520de3a18e5e111b5eaab095312d7fe84",
        maxWithdraw: 1000000000000000000n,
        maxRedeem: 1000000000000000000n,
      },
      position: {
        balance: 500000000000000000n,
        assets: 501234567890123456n,
      },
    }]);

    const result = await resolveErc4626Vault({
      client: {} as any,
      vault: "0xae7ab96520de3a18e5e111b5eaab095312d7fe84",
      owner: "0x1234567890123456789012345678901234567890",
    });

    expect(result.metadata.symbol).toBe("wstETH");
    expect(result.metadata.decimals).toBe(18);
    expect(result.metadata.underlyingAsset).toBe("0xae7ab96520de3a18e5e111b5eaab095312d7fe84");
    expect(result.position?.balance).toBe(500000000000000000n);
    expect(result.position?.assets).toBe(501234567890123456n);
  });

  it("skips step 2 when balance is undefined", async () => {
    (runMultistepTasks as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{
      metadata: {
        symbol: "wstETH",
        decimals: 18,
        underlyingAsset: "0xae7ab96520de3a18e5e111b5eaab095312d7fe84",
        maxWithdraw: 0n,
        maxRedeem: 0n,
      },
      position: { balance: undefined, assets: undefined },
    }]);

    const result = await resolveErc4626Vault({
      client: {} as any,
      vault: "0xae7ab96520de3a18e5e111b5eaab095312d7fe84",
      owner: "0x0000000000000000000000000000000000000000",
    });

    expect(result.position?.balance).toBeUndefined();
    expect(result.position?.assets).toBeUndefined();
  });
});

describe("resolveErc4626VaultsBulk", () => {
  it("batches step 1 and step 2 for all vaults into two multicalls", async () => {
    (runMultistepTasks as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { metadata: { symbol: "wstETH", decimals: 18, underlyingAsset: "0xae7ab96520de3a18e5e111b5eaab095312d7fe84", maxWithdraw: 1n, maxRedeem: 1n }, position: { balance: 1n, assets: 2n } },
      { metadata: { symbol: "rstETH", decimals: 18, underlyingAsset: "0xae7ab96520de3a18e5e111b5eaab095312d7fe84", maxWithdraw: 3n, maxRedeem: 3n }, position: { balance: 3n, assets: 6n } },
    ]);

    const results = await resolveErc4626VaultsBulk({
      client: {} as any,
      entries: [
        { vault: "0xae7ab96520de3a18e5e111b5eaab095312d7fe84", owner: "0x1234567890123456789012345678901234567890" },
        { vault: "0x21dD1dB4FE11338FDE9Bf81DDCd046e228B436F5", owner: "0x1234567890123456789012345678901234567890" },
      ],
    });

    expect(results).toHaveLength(2);
    expect(results[0]?.metadata.symbol).toBe("wstETH");
    expect(results[0]?.position?.assets).toBe(2n);
    expect(results[1]?.metadata.symbol).toBe("rstETH");
    expect(results[1]?.position?.assets).toBe(6n);
  });

  it("returns empty array for empty entries", async () => {
    const results = await resolveErc4626VaultsBulk({ client: {} as any, entries: [] });
    expect(results).toEqual([]);
  });
});
