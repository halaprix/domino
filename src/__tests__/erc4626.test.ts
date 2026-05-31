import { describe, it, expect, vi } from 'vitest'
import { resolveErc4626Vault, resolveErc4626VaultsBulk } from '../handlers/erc4626'
import type { StepExecutor, RawResult } from '../core/types'

/**
 * These tests mock the `StepExecutor` (executeMulticall) and run
 * the real FSM + handler, so step-gating and result routing are actually exercised.
 */

function mockExecutor(results: RawResult[][]): StepExecutor {
  const fn = vi.fn()
  for (const batch of results) {
    fn.mockResolvedValueOnce(batch)
  }
  return { executeMulticall: fn }
}

const vault = '0x7f39c5812d3f46fCEa82257f5aE43fF59E7E9F8a'
const owner = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'

describe('resolveErc4626Vault', () => {
  it('resolves metadata only (no owner) : single multicall, 3 calls', async () => {
    const executor = mockExecutor([
      [
        { status: 'success', value: 'wstETH' },
        { status: 'success', value: 18n },
        { status: 'success', value: '0xae7ab96520de3a18e5e111b5eaab095312d7fe84' },
      ],
    ])

    const result = await resolveErc4626Vault({ client: executor, vault })

    expect(executor.executeMulticall).toHaveBeenCalledTimes(1)
    // Step 1: symbol, decimals, asset
    const calls = (executor.executeMulticall as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(calls).toHaveLength(3)

    expect(result.metadata.symbol).toBe('wstETH')
    expect(result.metadata.decimals).toBe(18)
    expect(result.metadata.underlyingAsset?.toLowerCase()).toBe(
      '0xae7ab96520de3a18e5e111b5eaab095312d7fe84',
    )
    expect(result.position).toBeUndefined()
  })

  it('resolves metadata + position with owner : two multicalls (FSM step-gating)', async () => {
    const executor = mockExecutor([
      // Step 1: symbol, decimals, asset, balanceOf, maxWithdraw, maxRedeem
      [
        { status: 'success', value: 'wstETH' },
        { status: 'success', value: 18n },
        { status: 'success', value: '0xae7ab96520de3a18e5e111b5eaab095312d7fe84' },
        { status: 'success', value: 500000000000000000n },
        { status: 'success', value: 1000000000000000000n },
        { status: 'success', value: 1000000000000000000n },
      ],
      // Step 2: convertToAssets(balance) : uses value from Step 1
      [
        { status: 'success', value: 501234567890123456n },
      ],
    ])

    const result = await resolveErc4626Vault({ client: executor, vault, owner })

    expect(executor.executeMulticall).toHaveBeenCalledTimes(2)

    // Step 1 calls: symbol, decimals, asset, balanceOf, maxWithdraw, maxRedeem = 6
    const step1 = (executor.executeMulticall as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(step1).toHaveLength(6)
    expect(step1[3]).toMatchObject({ key: 'balance', functionName: 'balanceOf' })

    // Step 2 calls: convertToAssets(balance) = 1
    const step2 = (executor.executeMulticall as ReturnType<typeof vi.fn>).mock.calls[1]?.[0]
    expect(step2).toHaveLength(1)
    expect(step2[0]).toMatchObject({ key: 'assets', functionName: 'convertToAssets' })

    expect(result.metadata.symbol).toBe('wstETH')
    expect(result.metadata.maxWithdraw).toBe(1000000000000000000n)
    expect(result.metadata.maxRedeem).toBe(1000000000000000000n)
    expect(result.position?.balance).toBe(500000000000000000n)
    expect(result.position?.assets).toBe(501234567890123456n)
  })

  it('skips step 2 when balance call fails : single multicall despite owner', async () => {
    const executor = mockExecutor([
      // Step 1: balance call fails → step 2 should be skipped
      [
        { status: 'success', value: 'wstETH' },
        { status: 'success', value: 18n },
        { status: 'success', value: '0xae7ab96520de3a18e5e111b5eaab095312d7fe84' },
        { status: 'failure', value: undefined },
        { status: 'failure', value: undefined },
        { status: 'failure', value: undefined },
      ],
    ])

    const result = await resolveErc4626Vault({ client: executor, vault, owner })

    // Only 1 multicall : step 2 was skipped because balanceOf failed
    expect(executor.executeMulticall).toHaveBeenCalledTimes(1)
    expect(result.position?.balance).toBeUndefined()
    expect(result.position?.assets).toBeUndefined()
  })
})

describe('resolveErc4626VaultsBulk', () => {
  it('batches all vaults into two multicalls (shared step batching)', async () => {
    const executor = mockExecutor([
      // Step 1: 6 calls × 2 vaults = 12
      [
        { status: 'success', value: 'wstETH' },
        { status: 'success', value: 18n },
        { status: 'success', value: '0xae7ab96520de3a18e5e111b5eaab095312d7fe84' },
        { status: 'success', value: 1n },
        { status: 'success', value: 1n },
        { status: 'success', value: 1n },
        { status: 'success', value: 'rstETH' },
        { status: 'success', value: 18n },
        { status: 'success', value: '0xae7ab96520de3a18e5e111b5eaab095312d7fe84' },
        { status: 'success', value: 3n },
        { status: 'success', value: 3n },
        { status: 'success', value: 3n },
      ],
      // Step 2: convertToAssets × 2 vaults = 2
      [
        { status: 'success', value: 2n },
        { status: 'success', value: 6n },
      ],
    ])

    const results = await resolveErc4626VaultsBulk({
      client: executor,
      entries: [
        { vault: '0x7f39c5812d3f46fCEa82257f5aE43fF59E7E9F8a', owner },
        { vault: '0x21dD1dB4FE11338FDE9Bf81DDCd046e228B436F5', owner },
      ],
    })

    expect(executor.executeMulticall).toHaveBeenCalledTimes(2)

    // Step 1: 6 calls per vault × 2 vaults = 12
    expect((executor.executeMulticall as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toHaveLength(12)
    // Step 2: 1 call per vault × 2 vaults = 2
    expect((executor.executeMulticall as ReturnType<typeof vi.fn>).mock.calls[1]?.[0]).toHaveLength(2)

    expect(results).toHaveLength(2)
    expect(results[0]?.metadata.symbol).toBe('wstETH')
    expect(results[0]?.position?.balance).toBe(1n)
    expect(results[0]?.position?.assets).toBe(2n)
    expect(results[1]?.metadata.symbol).toBe('rstETH')
    expect(results[1]?.position?.balance).toBe(3n)
    expect(results[1]?.position?.assets).toBe(6n)
  })

  it('returns empty array for empty entries', async () => {
    const executor = mockExecutor([])
    const results = await resolveErc4626VaultsBulk({ client: executor, entries: [] })
    expect(results).toEqual([])
    expect(executor.executeMulticall).not.toHaveBeenCalled()
  })
})
