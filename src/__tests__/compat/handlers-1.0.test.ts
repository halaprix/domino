import { describe, it, expect, vi } from 'vitest'
import {
  resolveErc20Token,
  resolveErc20TokensBulk,
  resolveErc4626Vault,
  resolveErc4626VaultsBulk,
} from '@halaprix/domino'
import type { StepExecutor, RawResult, StepResult, Address } from '@halaprix/domino'

/**
 * 1.0-consumer compat — do not modernize these tests; they must keep passing on every 1.x release.
 *
 * Pattern: handler functions with `client:` param
 * - ERC20: resolveErc20Token, resolveErc20TokensBulk
 * - ERC4626: resolveErc4626Vault, resolveErc4626VaultsBulk
 * - All return shapes match v1.0 exactly
 */

function mockExecutor(results: RawResult[][]): { executeMulticall: ReturnType<typeof vi.fn> } {
  const fn = vi.fn()
  for (const batch of results) {
    fn.mockResolvedValueOnce(batch)
  }
  return { executeMulticall: fn }
}

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4' as Address
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as Address
const owner = '0x1234567890123456789012345678901234567890' as Address

describe('resolveErc20Token', () => {
  it('returns { symbol, decimals, balance } shape with owner', async () => {
    const executor = mockExecutor([
      [
        { status: 'success', value: 'USDC' },
        { status: 'success', value: 6n },
        { status: 'success', value: 1000000n },
      ],
    ])

    const result = await resolveErc20Token({
      client: executor,
      token: USDC,
      owner,
    })

    // Verify 1.0 return type shape
    expect(result).toHaveProperty('symbol')
    expect(result).toHaveProperty('decimals')
    expect(result).toHaveProperty('balance')
    expect(result.symbol).toBe('USDC')
    expect(result.decimals).toBe(6)
    expect(result.balance).toBe(1000000n)
  })

  it('returns { symbol, decimals, balance: undefined } shape without owner', async () => {
    const executor = mockExecutor([
      [
        { status: 'success', value: 'USDC' },
        { status: 'success', value: 6n },
      ],
    ])

    const result = await resolveErc20Token({
      client: executor,
      token: USDC,
    })

    expect(result.symbol).toBe('USDC')
    expect(result.decimals).toBe(6)
    expect(result.balance).toBeUndefined()
  })

  it('forwards block parameter to executor as second argument', async () => {
    const executorMock = vi.fn().mockResolvedValueOnce([
      { status: 'success', value: 'USDC' },
      { status: 'success', value: 6n },
    ])
    const executor: StepExecutor = { executeMulticall: executorMock }

    await resolveErc20Token({
      client: executor,
      token: USDC,
      block: { blockNumber: 19_000_000n },
    })

    // Verify block was passed to executeMulticall as second argument
    expect(executorMock).toHaveBeenNthCalledWith(
      1,
      expect.any(Array),
      { blockNumber: 19_000_000n },
    )
  })

  it('omits block parameter when not provided (defaults to undefined)', async () => {
    const executorMock = vi.fn().mockResolvedValueOnce([
      { status: 'success', value: 'USDC' },
      { status: 'success', value: 6n },
    ])
    const executor: StepExecutor = { executeMulticall: executorMock }

    await resolveErc20Token({
      client: executor,
      token: USDC,
    })

    // Verify block is undefined when not provided
    expect(executorMock).toHaveBeenNthCalledWith(
      1,
      expect.any(Array),
      undefined,
    )
  })
})

describe('resolveErc20TokensBulk', () => {
  it('returns array of { symbol, decimals, balance } shapes', async () => {
    // With 2 tokens × 3 calls each (symbol, decimals, balance) = 6 calls
    // batchSize: 2 means 3 batches of 2, 2, 2
    const executor = mockExecutor([
      // Batch 1: USDC symbol, USDC decimals
      [
        { status: 'success', value: 'USDC' },
        { status: 'success', value: 6n },
      ],
      // Batch 2: USDC balance, WETH symbol
      [
        { status: 'success', value: 1000000n },
        { status: 'success', value: 'WETH' },
      ],
      // Batch 3: WETH decimals, WETH balance
      [
        { status: 'success', value: 18n },
        { status: 'success', value: 2000000000000000000n },
      ],
    ])

    const results = await resolveErc20TokensBulk({
      client: executor,
      entries: [
        { token: USDC, owner },
        { token: WETH, owner },
      ],
      batchSize: 2,
    })

    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({
      symbol: 'USDC',
      decimals: 6,
      balance: 1000000n,
    })
    expect(results[1]).toMatchObject({
      symbol: 'WETH',
      decimals: 18,
      balance: 2000000000000000000n,
    })
  })

  it('returns empty array for empty entries', async () => {
    const executor = mockExecutor([])
    const results = await resolveErc20TokensBulk({
      client: executor,
      entries: [],
    })
    expect(results).toEqual([])
  })
})

describe('resolveErc4626Vault', () => {
  const vault = '0x7f39c5812d3f46fCEa82257f5aE43fF59E7E9F8a' as Address
  const asset = '0xae7ab96520de3a18e5e111b5eaab095312d7fe84' as Address

  it('returns metadata shape with owner and position', async () => {
    const executor = mockExecutor([
      // Step 1: symbol, decimals, asset, balanceOf, maxWithdraw, maxRedeem
      [
        { status: 'success', value: 'wstETH' },
        { status: 'success', value: 18n },
        { status: 'success', value: asset },
        { status: 'success', value: 500000000000000000n },
        { status: 'success', value: 1000000000000000000n },
        { status: 'success', value: 1000000000000000000n },
      ],
      // Step 2: convertToAssets
      [{ status: 'success', value: 501234567890123456n }],
    ])

    const result = await resolveErc4626Vault({
      client: executor,
      vault,
      owner,
    })

    // Verify metadata shape
    expect(result).toHaveProperty('metadata')
    expect(result.metadata).toHaveProperty('symbol')
    expect(result.metadata).toHaveProperty('decimals')
    expect(result.metadata).toHaveProperty('underlyingAsset')
    expect(result.metadata).toHaveProperty('maxWithdraw')
    expect(result.metadata).toHaveProperty('maxRedeem')

    expect(result.metadata.symbol).toBe('wstETH')
    expect(result.metadata.decimals).toBe(18)
    expect(result.metadata.underlyingAsset?.toLowerCase()).toBe(asset.toLowerCase())
    expect(result.metadata.maxWithdraw).toBe(1000000000000000000n)
    expect(result.metadata.maxRedeem).toBe(1000000000000000000n)

    // Verify position shape
    expect(result).toHaveProperty('position')
    expect(result.position).toHaveProperty('balance')
    expect(result.position).toHaveProperty('assets')
    expect(result.position?.balance).toBe(500000000000000000n)
    expect(result.position?.assets).toBe(501234567890123456n)
  })

  it('returns metadata shape without position when owner absent', async () => {
    const executor = mockExecutor([
      [
        { status: 'success', value: 'wstETH' },
        { status: 'success', value: 18n },
        { status: 'success', value: asset },
      ],
    ])

    const result = await resolveErc4626Vault({
      client: executor,
      vault,
    })

    expect(result.metadata.symbol).toBe('wstETH')
    expect(result.metadata.decimals).toBe(18)
    expect(result.metadata.underlyingAsset?.toLowerCase()).toBe(asset.toLowerCase())
    expect(result.position).toBeUndefined()
  })

  it('skips step 2 when balance call fails', async () => {
    const executor = mockExecutor([
      [
        { status: 'success', value: 'wstETH' },
        { status: 'success', value: 18n },
        { status: 'success', value: asset },
        { status: 'failure' },
        { status: 'failure' },
        { status: 'failure' },
      ],
    ])

    const result = await resolveErc4626Vault({
      client: executor,
      vault,
      owner,
    })

    expect(result.metadata.symbol).toBe('wstETH')
    expect(result.position?.balance).toBeUndefined()
    expect(result.position?.assets).toBeUndefined()
  })

  it('forwards block parameter through both step 1 and step 2', async () => {
    const executorMock = vi.fn()
    executorMock.mockResolvedValueOnce([
      { status: 'success', value: 'wstETH' },
      { status: 'success', value: 18n },
      { status: 'success', value: asset },
      { status: 'success', value: 500000000000000000n },
      { status: 'success', value: 1000000000000000000n },
      { status: 'success', value: 1000000000000000000n },
    ])
    executorMock.mockResolvedValueOnce([
      { status: 'success', value: 501234567890123456n },
    ])
    const executor: StepExecutor = { executeMulticall: executorMock }

    await resolveErc4626Vault({
      client: executor,
      vault,
      owner,
      block: { blockNumber: 19_000_000n },
    })

    // Verify block was passed for step 1
    expect(executorMock).toHaveBeenNthCalledWith(
      1,
      expect.any(Array),
      { blockNumber: 19_000_000n },
    )
    // Verify block was passed for step 2
    expect(executorMock).toHaveBeenNthCalledWith(
      2,
      expect.any(Array),
      { blockNumber: 19_000_000n },
    )
  })

  it('omits block parameter in both steps when not provided', async () => {
    const executorMock = vi.fn()
    executorMock.mockResolvedValueOnce([
      { status: 'success', value: 'wstETH' },
      { status: 'success', value: 18n },
      { status: 'success', value: asset },
      { status: 'success', value: 500000000000000000n },
      { status: 'success', value: 1000000000000000000n },
      { status: 'success', value: 1000000000000000000n },
    ])
    executorMock.mockResolvedValueOnce([
      { status: 'success', value: 501234567890123456n },
    ])
    const executor: StepExecutor = { executeMulticall: executorMock }

    await resolveErc4626Vault({
      client: executor,
      vault,
      owner,
    })

    // Verify block is undefined for step 1
    expect(executorMock).toHaveBeenNthCalledWith(
      1,
      expect.any(Array),
      undefined,
    )
    // Verify block is undefined for step 2
    expect(executorMock).toHaveBeenNthCalledWith(
      2,
      expect.any(Array),
      undefined,
    )
  })
})

describe('resolveErc4626VaultsBulk', () => {
  const vault1 = '0x7f39c5812d3f46fCEa82257f5aE43fF59E7E9F8a' as Address
  const vault2 = '0x21dD1dB4FE11338FDE9Bf81DDCd046e228B436F5' as Address
  const asset = '0xae7ab96520de3a18e5e111b5eaab095312d7fe84' as Address

  it('returns array of metadata + position shapes', async () => {
    const executor = mockExecutor([
      // Step 1: 6 calls per vault × 2 = 12
      [
        { status: 'success', value: 'wstETH' },
        { status: 'success', value: 18n },
        { status: 'success', value: asset },
        { status: 'success', value: 1n },
        { status: 'success', value: 1n },
        { status: 'success', value: 1n },
        { status: 'success', value: 'rstETH' },
        { status: 'success', value: 18n },
        { status: 'success', value: asset },
        { status: 'success', value: 3n },
        { status: 'success', value: 3n },
        { status: 'success', value: 3n },
      ],
      // Step 2: 1 call per vault × 2 = 2
      [
        { status: 'success', value: 2n },
        { status: 'success', value: 6n },
      ],
    ])

    const results = await resolveErc4626VaultsBulk({
      client: executor,
      entries: [
        { vault: vault1, owner },
        { vault: vault2, owner },
      ],
    })

    expect(results).toHaveLength(2)

    // Verify first vault
    expect(results[0]?.metadata.symbol).toBe('wstETH')
    expect(results[0]?.metadata.maxWithdraw).toBe(1n)
    expect(results[0]?.metadata.maxRedeem).toBe(1n)
    expect(results[0]?.position?.balance).toBe(1n)
    expect(results[0]?.position?.assets).toBe(2n)

    // Verify second vault
    expect(results[1]?.metadata.symbol).toBe('rstETH')
    expect(results[1]?.position?.balance).toBe(3n)
    expect(results[1]?.position?.assets).toBe(6n)
  })

  it('returns empty array for empty entries', async () => {
    const executor = mockExecutor([])
    const results = await resolveErc4626VaultsBulk({
      client: executor,
      entries: [],
    })
    expect(results).toEqual([])
  })
})
