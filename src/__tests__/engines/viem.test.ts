import { describe, it, expect, vi } from 'vitest'
import { createResolver } from '../../engines/viem'
import type { PublicClient } from 'viem'

describe('viem engine', () => {
  it('resolves ERC20 symbol and decimals', async () => {
    // viem multicall returns decoded values; string results come back as [string]
    const mockClient = {
      multicall: vi.fn().mockResolvedValue([
        // symbol() returns array wrapper
        { status: 'success', result: ['USDC'] },
        // decimals() returns the bigint directly
        { status: 'success', result: 6n },
      ]),
    } as unknown as PublicClient

    const resolver = createResolver(mockClient)
    const result = await resolver.resolveErc20({
      token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    })

    expect(result.symbol).toBe('USDC')
    expect(result.decimals).toBe(6)
  })

  it('resolves ERC4626 with owner (2-step)', async () => {
    const mockClient = {
      multicall: vi
        .fn()
        .mockResolvedValueOnce([
          // Step 1: symbol, decimals, asset, balanceOf, maxWithdraw, maxRedeem
          { status: 'success', result: ['wstETH'] },
          { status: 'success', result: 18n },
          { status: 'success', result: ['0xae7ab96520de3a18e5e111b5eaab095312d7fe84'] },
          { status: 'success', result: 1n },
          { status: 'success', result: 1n },
          { status: 'success', result: 1n },
        ])
        // Step 2: convertToAssets(balance)
        .mockResolvedValueOnce([{ status: 'success', result: 2n }]),
    } as unknown as PublicClient

    const resolver = createResolver(mockClient)
    const result = await resolver.resolveErc4626({
      vault: '0x7f39c5812d3f46fCEa82257f5aE43fF59E7E9F8a',
      owner: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
    })

    expect(result.metadata.symbol).toBe('wstETH')
    expect(result.metadata.decimals).toBe(18)
    expect(result.metadata.underlyingAsset?.toLowerCase()).toBe(
      '0xae7ab96520de3a18e5e111b5eaab095312d7fe84',
    )
    expect(result.position?.balance).toBe(1n)
    expect(result.position?.assets).toBe(2n)
  })

  it('resolveErc20Bulk batches into single multicall', async () => {
    const mockClient = {
      multicall: vi.fn().mockResolvedValue([
        { status: 'success', result: ['USDC'] },
        { status: 'success', result: 6n },
        { status: 'success', result: ['DAI'] },
        { status: 'success', result: 18n },
      ]),
    } as unknown as PublicClient

    const resolver = createResolver(mockClient)
    const results = await resolver.resolveErc20Bulk({
      entries: [
        { token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
        { token: '0x6B175474E89094C44Da98b954EedeAC495271d0F' },
      ],
    })

    expect(results).toHaveLength(2)
    expect(results[0]!.symbol).toBe('USDC')
    expect(results[0]!.decimals).toBe(6)
    expect(results[1]!.symbol).toBe('DAI')
    expect(results[1]!.decimals).toBe(18)
    expect(mockClient.multicall).toHaveBeenCalledTimes(1)
  })

  it('handles failed calls gracefully', async () => {
    const mockClient = {
      multicall: vi.fn().mockResolvedValue([
        { status: 'failure', returnData: undefined },
        { status: 'success', result: 6n },
      ]),
    } as unknown as PublicClient

    const resolver = createResolver(mockClient)
    const result = await resolver.resolveErc20({
      token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    })

    expect(result.symbol).toBeUndefined()
    expect(result.decimals).toBe(6)
  })

  it('returns empty array for empty bulk', async () => {
    const mockClient = {
      multicall: vi.fn(),
    } as unknown as PublicClient

    const resolver = createResolver(mockClient)
    const results = await resolver.resolveErc20Bulk({ entries: [] })

    expect(results).toEqual([])
    expect(mockClient.multicall).not.toHaveBeenCalled()
  })
})
