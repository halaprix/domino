import { describe, it, expect, vi } from 'vitest'
import { MulticallResolver } from '../../index'
import type { StepExecutor, RawResult } from '../../index'

/**
 * 1.0-consumer compat — do not modernize these tests; they must keep passing on every 1.x release.
 *
 * Pattern: positional resolver construction + run()
 * - `new MulticallResolver(executor)` positional constructor
 * - `resolver.run([task], options?)` generic execution
 * - `resolver.executor` getter returns the underlying executor
 */

function mockExecutor(results: RawResult[][]): StepExecutor {
  const fn = vi.fn()
  for (const batch of results) {
    fn.mockResolvedValueOnce(batch)
  }
  return { executeMulticall: fn }
}

describe('MulticallResolver 1.0', () => {
  it('constructs via positional argument and exposes executor getter', () => {
    const executor = mockExecutor([])
    const resolver = new MulticallResolver(executor)

    // The resolver's executor getter must return the exact executor passed in
    expect(resolver.executor).toBe(executor)
  })

  it('executes generic tasks via run() with batchSize and block options', async () => {
    const executor = mockExecutor([
      [
        { status: 'success', value: 'USDC' },
        { status: 'success', value: 6n },
      ],
    ])

    const resolver = new MulticallResolver(executor)
    const ctx: { symbol?: string; decimals?: number } = {}

    const task = {
      maxStep: 1,
      buildStepCalls(step: number) {
        if (step !== 1) return []
        return [
          {
            key: 'symbol',
            target: '0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4' as const,
            abi: [],
            functionName: 'symbol',
          },
          {
            key: 'decimals',
            target: '0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4' as const,
            abi: [],
            functionName: 'decimals',
          },
        ]
      },
      consumeStepResults(_step: number, results: any[]) {
        for (const r of results) {
          if (r.status === 'failure') continue
          if (r.key === 'symbol') ctx.symbol = r.value
          if (r.key === 'decimals') ctx.decimals = Number(r.value)
        }
      },
      finalize() {
        return { symbol: ctx.symbol, decimals: ctx.decimals }
      },
    }

    // Call run() with batchSize and block in options parameter
    const [result] = await resolver.run([task], {
      batchSize: 2,
      block: { blockNumber: 1n },
    })

    expect(result?.symbol).toBe('USDC')
    expect(result?.decimals).toBe(6)
  })

  it('executes generic tasks without options (run default behavior)', async () => {
    const executor = mockExecutor([
      [{ status: 'success', value: 'DAI' }],
    ])

    const resolver = new MulticallResolver(executor)
    const task = {
      maxStep: 1,
      buildStepCalls(step: number) {
        if (step !== 1) return []
        return [
          {
            key: 'symbol',
            target: '0x6B175474E89094C44Da98b954EedeAC495271d0F' as const,
            abi: [],
            functionName: 'symbol',
          },
        ]
      },
      consumeStepResults() {},
      finalize() {
        return { value: 'result' }
      },
    }

    const [result] = await resolver.run([task])
    expect(result).toEqual({ value: 'result' })
  })
})
