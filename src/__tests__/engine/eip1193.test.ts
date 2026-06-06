import { describe, it, expect, vi } from 'vitest'
import { parseAbi, encodeFunctionResult, encodeAbiParameters } from 'viem'
import { Eip1193Executor } from '../../engine/eip1193'

// Helper to encode an aggregate3 response with one successful call
function encodeAggregate3Result(innerAbi: readonly unknown[], fn: string, innerResult: unknown): string {
  const returnData = encodeFunctionResult({
    abi: innerAbi,
    functionName: fn,
    result: innerResult,
  } as any) as `0x${string}`

  const result = encodeAbiParameters(
    [{ type: 'tuple[]', components: [{ name: 'success', type: 'bool' }, { name: 'returnData', type: 'bytes' }] }],
    [[{ success: true, returnData }]],
  )

  return result
}

// Helper to encode an aggregate3 response with one failed call
function encodeAggregate3Failure(): string {
  const result = encodeAbiParameters(
    [{ type: 'tuple[]', components: [{ name: 'success', type: 'bool' }, { name: 'returnData', type: 'bytes' }] }],
    [[{ success: false, returnData: '0x' }]],
  )
  return result
}

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as const
const totalSupplyAbi = parseAbi(['function totalSupply() view returns (uint256)'])

describe('Eip1193Executor', () => {
  it('sends eth_call to deployed Multicall3 for mainnet at latest', async () => {
    const ONE_MILLION = 1_000_000n
    const mockResult = encodeAggregate3Result(
      totalSupplyAbi as any,
      'totalSupply',
      ONE_MILLION,
    )

    const provider = {
      request: vi.fn()
        .mockResolvedValueOnce('0x1') // eth_chainId → chain 1
        .mockResolvedValueOnce(mockResult), // eth_call
    }

    const executor = new Eip1193Executor(provider)
    const results = await executor.executeMulticall([
      {
        key: 'ts',
        target: WETH,
        abi: totalSupplyAbi,
        functionName: 'totalSupply',
      },
    ])

    expect(results).toHaveLength(1)
    expect(results[0]!.status).toBe('success')
    const successResult = results[0]!
    if (successResult.status === 'success') {
      expect(successResult.value).toBe(ONE_MILLION)
    }

    // Verify deployed path: should have 'to' field pointing to Multicall3
    const callArgs = provider.request.mock.calls[1]![0]
    expect(callArgs.method).toBe('eth_call')
    expect(callArgs.params[0].to).toBe('0xcA11bde05977b3631167028862bE2a173976CA11')
  })

  it('uses deployless for mainnet before 14,353,601', async () => {
    const ONE_MILLION = 1_000_000n
    const mockResult = encodeAggregate3Result(
      totalSupplyAbi as any,
      'totalSupply',
      ONE_MILLION,
    )

    const provider = {
      request: vi.fn()
        .mockResolvedValueOnce('0x1') // eth_chainId
        .mockResolvedValueOnce(mockResult), // eth_call
    }

    const executor = new Eip1193Executor(provider)
    const results = await executor.executeMulticall(
      [
        {
          key: 'ts',
          target: WETH,
          abi: totalSupplyAbi,
          functionName: 'totalSupply',
        },
      ],
      { blockNumber: 5_000_000n },
    )

    expect(results).toHaveLength(1)
    expect(results[0]!.status).toBe('success')

    // Deployless should NOT have 'to' field
    const callArgs = provider.request.mock.calls[1]![0]
    const params = callArgs.params[0]
    expect(params.to).toBeUndefined()
    // Should have 'data' starting with deployless wrapper
    expect(params.data).toBeDefined()
  }, 10000)

  it('returns failure for reverted calls', async () => {
    const mockResult = encodeAggregate3Failure()

    const provider = {
      request: vi.fn()
        .mockResolvedValueOnce('0x1') // eth_chainId
        .mockResolvedValueOnce(mockResult), // eth_call
    }

    const executor = new Eip1193Executor(provider)
    const results = await executor.executeMulticall([
      {
        key: 'bad',
        target: WETH,
        abi: totalSupplyAbi,
        functionName: 'totalSupply',
      },
    ])

    expect(results).toHaveLength(1)
    expect(results[0]!.status).toBe('failure')
  })

  it('returns empty array for zero calls', async () => {
    const provider = { request: vi.fn() }
    const executor = new Eip1193Executor(provider)
    const results = await executor.executeMulticall([])
    expect(results).toEqual([])
    expect(provider.request).not.toHaveBeenCalled()
  })

  it('falls back to deployless on contract-not-found error', async () => {
    const ONE_MILLION = 1_000_000n
    const mockResult = encodeAggregate3Result(
      totalSupplyAbi as any,
      'totalSupply',
      ONE_MILLION,
    )

    const provider = {
      request: vi.fn()
        .mockResolvedValueOnce('0x1') // eth_chainId
        .mockRejectedValueOnce(new Error('execution reverted: no contract at address')) // first eth_call fails
        .mockResolvedValueOnce(mockResult), // second eth_call (deployless) succeeds
    }

    const executor = new Eip1193Executor(provider)
    const results = await executor.executeMulticall([
      {
        key: 'ts',
        target: WETH,
        abi: totalSupplyAbi,
        functionName: 'totalSupply',
      },
    ])

    expect(results).toHaveLength(1)
    expect(results[0]!.status).toBe('success')

    // Second attempt should be deployless (no 'to')
    const secondCall = provider.request.mock.calls[2]![0]
    expect(secondCall.params[0].to).toBeUndefined()
  })

  it('caches chainId after first detection', async () => {
    const mockResult = encodeAggregate3Result(
      totalSupplyAbi as any,
      'totalSupply',
      1000n,
    )

    const provider = {
      request: vi.fn()
        .mockResolvedValueOnce('0x1') // first eth_chainId
        .mockResolvedValueOnce(mockResult) // first execute
        .mockResolvedValueOnce(mockResult), // second execute (no chainId call needed)
    }

    const executor = new Eip1193Executor(provider)
    await executor.executeMulticall([
      { key: 'a', target: WETH, abi: totalSupplyAbi, functionName: 'totalSupply' },
    ])
    await executor.executeMulticall([
      { key: 'b', target: WETH, abi: totalSupplyAbi, functionName: 'totalSupply' },
    ])

    // chainId should have been called exactly once
    const chainIdCalls = provider.request.mock.calls.filter(
      (call: any) => call[0].method === 'eth_chainId',
    )
    expect(chainIdCalls).toHaveLength(1)
  })
})
