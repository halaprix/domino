/**
 * Integration tests that exercise REAL ABI encoding/decoding.
 *
 * Unlike the other engine tests (which mock `client.multicall` / the ethers
 * `Interface`), these drive a real viem PublicClient through a stub transport.
 * The only thing that can break here is the library's own ABI handling — which
 * is exactly the layer the mocked tests cannot see.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  createPublicClient,
  custom,
  encodeAbiParameters,
  parseAbiParameters,
  type PublicClient,
} from 'viem'
import { mainnet } from 'viem/chains'
import { AbiCoder } from 'ethers'
import { utils as utilsV5 } from 'ethers-v5'
import { createResolver } from '../../engines/viem'
import { createResolver as createEthersV6Resolver } from '../../engines/ethers-v6'
import { createResolver as createEthersV5Resolver } from '../../engines/ethers-v5'

/** Encode an aggregate3 response: (bool success, bytes returnData)[]. */
function encodeAggregate3(returns: `0x${string}`[]): `0x${string}` {
  return encodeAbiParameters(parseAbiParameters('(bool success, bytes returnData)[]'), [
    returns.map((returnData) => ({ success: true, returnData })),
  ])
}

/**
 * Build a PublicClient whose eth_call always returns the supplied aggregate3
 * payload. `withChain` controls whether the client has a chain configured.
 */
function stubClient(aggregate3Return: `0x${string}`, withChain = true): PublicClient {
  const transport = custom({
    async request({ method }) {
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_call') return aggregate3Return
      throw new Error(`unexpected RPC method: ${method}`)
    },
  })
  return createPublicClient(withChain ? { chain: mainnet, transport } : { transport })
}

describe('viem engine — real ABI encoding', () => {
  it('encodes/decodes ERC20 symbol() and decimals() against a real client', async () => {
    const aggregate3Return = encodeAggregate3([
      encodeAbiParameters(parseAbiParameters('string'), ['USDC']),
      encodeAbiParameters(parseAbiParameters('uint8'), [6]),
    ])

    const resolver = createResolver(stubClient(aggregate3Return))
    const result = await resolver.resolveErc20({
      token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    })

    expect(result.symbol).toBe('USDC')
    expect(result.decimals).toBe(6)
  })

  it('works without a chain configured (uses well-known Multicall3 address)', async () => {
    const aggregate3Return = encodeAggregate3([
      encodeAbiParameters(parseAbiParameters('string'), ['DAI']),
      encodeAbiParameters(parseAbiParameters('uint8'), [18]),
    ])

    const resolver = createResolver(stubClient(aggregate3Return, /* withChain */ false))
    const result = await resolver.resolveErc20({
      token: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    })

    expect(result.symbol).toBe('DAI')
    expect(result.decimals).toBe(18)
  })
})

describe('ethers v6 engine — real Interface from ercCombinedAbi', () => {
  it('builds a real Interface and encodes/decodes ERC20 calls', async () => {
    const coder = AbiCoder.defaultAbiCoder()
    const mockContract = {
      aggregate3: vi.fn().mockResolvedValue([
        { success: true, returnData: coder.encode(['string'], ['USDC']) },
        { success: true, returnData: coder.encode(['uint8'], [6]) },
      ]),
    }
    const mockProvider = { getNetwork: async () => ({ chainId: 1 }) }

    // No Interface passed → engine builds `new Interface(ercCombinedAbi)` itself.
    const resolver = createEthersV6Resolver(
      mockProvider as never,
      mockContract as never,
    )
    const result = await resolver.resolveErc20({
      token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    })

    expect(result.symbol).toBe('USDC')
    expect(result.decimals).toBe(6)
  })
})

describe('ethers v5 engine — real Interface from ercCombinedAbi', () => {
  it('builds a real Interface and encodes/decodes ERC20 calls', async () => {
    const mockContract = {
      aggregate3: vi.fn().mockResolvedValue([
        { success: true, returnData: utilsV5.defaultAbiCoder.encode(['string'], ['USDC']) },
        { success: true, returnData: utilsV5.defaultAbiCoder.encode(['uint8'], [6]) },
      ]),
    }
    const mockProvider = {}

    // No Interface passed → engine builds `new utils.Interface(ercCombinedAbi)` itself.
    const resolver = createEthersV5Resolver(
      mockProvider as never,
      mockContract as never,
    )
    const result = await resolver.resolveErc20({
      token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    })

    expect(result.symbol).toBe('USDC')
    expect(result.decimals).toBe(6)
  })
})
