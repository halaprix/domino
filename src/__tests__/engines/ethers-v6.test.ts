import { describe, it, expect, vi } from 'vitest'
import { createResolver } from '../../engines/ethers-v6'
import type { BrowserProvider, Contract, Interface } from 'ethers'

describe('ethers v6 engine', () => {
  it('resolves ERC20 symbol and decimals', async () => {
    const mockInterface = {
      encodeFunctionData: vi.fn().mockReturnValue('0x'),
      decodeFunctionResult: vi.fn().mockReturnValueOnce(['USDC']).mockReturnValueOnce([6n]),
    } as unknown as Interface

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

    const mockProvider = {
      getNetwork: async () => ({ chainId: 1 }),
    } as unknown as BrowserProvider

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
        .mockReturnValueOnce(['wstETH'])
        .mockReturnValueOnce([18n])
        .mockReturnValueOnce(['0xae7ab96520de3a18e5e111b5eaab095312d7fe84']) // asset
        .mockReturnValueOnce([1000000n]) // balance
        .mockReturnValueOnce([1000000n]) // maxWithdraw
        .mockReturnValueOnce([1000000n]) // maxRedeem
        .mockReturnValueOnce([900000n]), // convertToAssets result
    } as unknown as Interface

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

    const mockProvider = {
      getNetwork: async () => ({ chainId: 1 }),
    } as unknown as BrowserProvider

    const resolver = createResolver(mockProvider, mockContract, mockInterface)
    const result = await resolver.resolveErc4626({
      vault: '0x1234',
      owner: '0xabcd',
    })

    expect(result.metadata.symbol).toBe('wstETH')
    expect(result.metadata.decimals).toBe(18)
    expect(result.metadata.underlyingAsset).toBe('0xae7ab96520de3a18e5e111b5eaab095312d7fe84')
    expect(result.position).toBeDefined()
    expect(result.position!.balance).toBe(1000000n)
    expect(result.position!.assets).toBe(900000n)
  })

  it('resolveErc20Bulk batches into single multicall', async () => {
    const mockInterface = {
      encodeFunctionData: vi.fn().mockReturnValue('0x'),
      decodeFunctionResult: vi
        .fn()
        .mockReturnValueOnce(['USDC'])
        .mockReturnValueOnce([6n])
        .mockReturnValueOnce(['DAI'])
        .mockReturnValueOnce([18n]),
    } as unknown as Interface

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

    const mockProvider = {
      getNetwork: async () => ({ chainId: 1 }),
    } as unknown as BrowserProvider

    const resolver = createResolver(mockProvider, mockContract, mockInterface)
    const results = await resolver.resolveErc20Bulk({
      entries: [
        { token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
        { token: '0x6B175474E89094C44Da98b954EescdeCB5BE3834' },
      ],
    })

    expect(results).toHaveLength(2)
    expect(results[0]!.symbol).toBe('USDC')
    expect(results[0]!.decimals).toBe(6)
    expect(results[1]!.symbol).toBe('DAI')
    expect(results[1]!.decimals).toBe(18)
  })

  it('handles failed calls gracefully', async () => {
    const mockInterface = {
      encodeFunctionData: vi.fn().mockReturnValue('0x'),
      decodeFunctionResult: vi.fn().mockReturnValue(['FAILURE']),
    } as unknown as Interface

    const mockContract = {
      aggregate3: vi.fn().mockResolvedValue([
        { success: false, returnData: '0x' },
        { success: false, returnData: '0x' },
      ]),
    } as unknown as Contract

    const mockProvider = {
      getNetwork: async () => ({ chainId: 1 }),
    } as unknown as BrowserProvider

    const resolver = createResolver(mockProvider, mockContract, mockInterface)
    const result = await resolver.resolveErc20({
      token: '0xdead00000000000000000000000000000000dead',
    })

    // Failed calls should result in undefined values
    expect(result.symbol).toBeUndefined()
    expect(result.decimals).toBeUndefined()
  })

  it('returns empty array for empty bulk', async () => {
    const mockInterface = {} as unknown as Interface
    const mockContract = {} as unknown as Contract
    const mockProvider = {
      getNetwork: async () => ({ chainId: 1 }),
    } as unknown as BrowserProvider

    const resolver = createResolver(mockProvider, mockContract, mockInterface)
    const results = await resolver.resolveErc20Bulk({ entries: [] })

    expect(results).toEqual([])
  })
})
