import { describe, it, expect, vi } from 'vitest'
import { createResolver } from '../../engines/ethers-v5'
import type { Contract, utils } from 'ethers-v5'

describe('ethers v5 engine', () => {
  it('resolves ERC20 symbol and decimals', async () => {
    // ethers v5 decodeFunctionResult returns { 0: "USDC", symbol: "USDC" }
    const mockInterface = {
      encodeFunctionData: vi.fn().mockReturnValue('0x'),
      decodeFunctionResult: vi
        .fn()
        .mockReturnValueOnce(['USDC'] as unknown)
        .mockReturnValueOnce([6] as unknown),
    } as unknown as utils.Interface

    const mockContract = {
      aggregate3: vi.fn().mockResolvedValue([
        {
          success: true,
          returnData:
            '0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000455532430000000000000000000000000000000000000000000000000000000000',
        },
        {
          success: true,
          returnData: '0x0000000000000000000000000000000000000000000000000000000000000006',
        },
      ]),
    } as unknown as Contract

    const mockProvider = {} as import('ethers-v5').providers.Provider

    const resolver = createResolver(mockProvider, mockContract, mockInterface)
    const result = await resolver.resolveErc20({
      token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    })

    expect(result.symbol).toBe('USDC')
    expect(result.decimals).toBe(6)
  })

  it('resolves ERC4626 with owner (2-step)', async () => {
    const mockInterface = {
      encodeFunctionData: vi.fn().mockReturnValue('0x'),
      decodeFunctionResult: vi
        .fn()
        .mockReturnValueOnce(['wstETH'] as unknown)
        .mockReturnValueOnce([18] as unknown)
        .mockReturnValueOnce(['0xae7ab96520de3a18e5e111b5eaab095312d7fe84'] as unknown)
        .mockReturnValueOnce([1000000n] as unknown)
        .mockReturnValueOnce([1000000n] as unknown)
        .mockReturnValueOnce([1000000n] as unknown)
        .mockReturnValueOnce([900000n] as unknown),
    } as unknown as utils.Interface

    const mockContract = {
      aggregate3: vi
        .fn()
        .mockResolvedValueOnce([
          {
            success: true,
            returnData:
              '0x000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000077374554480000000000000000000000000000000000000000000000000000000',
          },
          {
            success: true,
            returnData: '0x0000000000000000000000000000000000000000000000000000000000000012',
          },
          {
            success: true,
            returnData: '0x000000000000000000000000ae7ab96520de3a18e5e111b5eaab095312d7fe84',
          },
          {
            success: true,
            returnData: '0x0000000000000000000000000000000000000000000000000000000000000f4240',
          },
          {
            success: true,
            returnData: '0x0000000000000000000000000000000000000000000000000000000000000f4240',
          },
          {
            success: true,
            returnData: '0x0000000000000000000000000000000000000000000000000000000000000f4240',
          },
        ])
        .mockResolvedValueOnce([
          {
            success: true,
            returnData: '0x0000000000000000000000000000000000000000000000000000000000000dbba0',
          },
        ]),
    } as unknown as Contract

    const mockProvider = {} as import('ethers-v5').providers.Provider

    const resolver = createResolver(mockProvider, mockContract, mockInterface)
    const result = await resolver.resolveErc4626({
      vault: '0x7f39c5812d3f46fCEa82257f5aE43fF59E7E9F8a',
      owner: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
    })

    expect(result.metadata.symbol).toBe('wstETH')
    expect(result.metadata.decimals).toBe(18)
    expect(result.metadata.underlyingAsset?.toLowerCase()).toBe(
      '0xae7ab96520de3a18e5e111b5eaab095312d7fe84',
    )
    expect(result.position?.balance).toBe(1000000n)
    expect(result.position?.assets).toBe(900000n)
  })

  it('resolveErc20Bulk batches into single multicall', async () => {
    const mockInterface = {
      encodeFunctionData: vi.fn().mockReturnValue('0x'),
      decodeFunctionResult: vi
        .fn()
        .mockReturnValueOnce(['USDC'] as unknown)
        .mockReturnValueOnce([6] as unknown)
        .mockReturnValueOnce(['DAI'] as unknown)
        .mockReturnValueOnce([18] as unknown),
    } as unknown as utils.Interface

    const mockContract = {
      aggregate3: vi.fn().mockResolvedValue([
        {
          success: true,
          returnData:
            '0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000455532430000000000000000000000000000000000000000000000000000000000',
        },
        {
          success: true,
          returnData: '0x0000000000000000000000000000000000000000000000000000000000000006',
        },
        {
          success: true,
          returnData:
            '0x000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000044414900000000000000000000000000000000000000000000000000000000000',
        },
        {
          success: true,
          returnData: '0x0000000000000000000000000000000000000000000000000000000000000012',
        },
      ]),
    } as unknown as Contract

    const mockProvider = {} as import('ethers-v5').providers.Provider

    const resolver = createResolver(mockProvider, mockContract, mockInterface)
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
    expect(mockContract.aggregate3).toHaveBeenCalledTimes(1)
  })

  it('handles failed calls gracefully', async () => {
    const mockInterface = {
      encodeFunctionData: vi.fn().mockReturnValue('0x'),
      decodeFunctionResult: vi.fn(),
    } as unknown as utils.Interface

    const mockContract = {
      aggregate3: vi.fn().mockResolvedValue([
        { success: false, returnData: '0x' },
        { success: false, returnData: '0x' },
      ]),
    } as unknown as Contract

    const mockProvider = {} as import('ethers-v5').providers.Provider

    const resolver = createResolver(mockProvider, mockContract, mockInterface)
    const result = await resolver.resolveErc20({
      token: '0xdead00000000000000000000000000000000dead',
    })

    expect(result.symbol).toBeUndefined()
    expect(result.decimals).toBeUndefined()
  })

  it('returns empty array for empty bulk', async () => {
    const mockInterface = {} as unknown as utils.Interface
    const mockContract = {} as unknown as Contract

    const mockProvider = {} as import('ethers-v5').providers.Provider

    const resolver = createResolver(mockProvider, mockContract, mockInterface)
    const results = await resolver.resolveErc20Bulk({ entries: [] })

    expect(results).toEqual([])
  })
})
