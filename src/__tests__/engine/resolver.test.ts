import { describe, it, expect, vi } from 'vitest'
import { MulticallResolver } from '../../engine/resolver'
import type { MultistepTask, StepCall, StepExecutor, RawResult } from '../../core/types'

const ADDR = '0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4' as const

describe('MulticallResolver.runSettled (F5)', () => {
  it('delegates to the standalone runSettled and returns the same shape of results', async () => {
    const mockExecutor: StepExecutor = {
      async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
        return calls.map((c) => ({ status: 'success' as const, value: 'v-' + c.key }))
      },
    }

    const resolver = new MulticallResolver(mockExecutor)

    const task: MultistepTask<{ v: string }> = {
      maxStep: 1,
      buildStepCalls(step) {
        if (step !== 1) return []
        return [{ key: 'a', target: ADDR, abi: [], functionName: 'symbol' }]
      },
      consumeStepResults() {},
      finalize() {
        return { v: 'v-a' }
      },
    }

    const results = await resolver.runSettled([task])

    expect(results).toEqual([
      { status: 'fulfilled', value: { v: 'v-a' }, diagnostics: { optionalFailures: [] } },
    ])
  })

  it('forwards block and batchSize options through to the executor', async () => {
    const executorMock = vi.fn().mockResolvedValueOnce([{ status: 'success', value: 'USDC' }])
    const resolver = new MulticallResolver({ executeMulticall: executorMock })

    const task: MultistepTask<Record<string, never>> = {
      maxStep: 1,
      buildStepCalls(step) {
        if (step !== 1) return []
        return [{ key: 'symbol', target: ADDR, abi: [], functionName: 'symbol' }]
      },
      consumeStepResults() {},
      finalize() {
        return {}
      },
    }

    await resolver.runSettled([task], { block: { blockNumber: 19_000_000n }, batchSize: 5 })

    expect(executorMock).toHaveBeenNthCalledWith(1, expect.any(Array), { blockNumber: 19_000_000n })
  })
})
