import { describe, it, expect } from 'vitest'
import { runMultistepTasks } from '../core/runMultistepTasks'
import type { MultistepTask, StepCall, StepResult, StepExecutor } from '../core/types'

describe('runMultistepTasks', () => {
  it('executes single-step task and returns result', async () => {
    const mockExecutor: StepExecutor = {
      async executeMulticall(_calls: StepCall[]): Promise<any[]> {
        return [
          { status: 'success', value: 'USDC' },
          { status: 'success', value: 6n },
        ]
      },
    }

    // Capture values in consumeStepResults so finalize derives from them :
    // validates that result routing actually works (not just hardcoded return)
    const ctx: { symbol?: string; decimals?: number } = {}

    const task: MultistepTask<{ symbol: string; decimals: number }> = {
      maxStep: 1,
      buildStepCalls(step) {
        if (step !== 1) return []
        return [
          {
            key: 'symbol',
            target: '0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4',
            abi: [],
            functionName: 'symbol',
          },
          {
            key: 'decimals',
            target: '0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4',
            abi: [],
            functionName: 'decimals',
          },
        ]
      },
      consumeStepResults(_step, results) {
        for (const r of results) {
          if (r.key === 'symbol') ctx.symbol = r.value as string
          if (r.key === 'decimals') ctx.decimals = Number(r.value)
        }
      },
      finalize() {
        return { symbol: ctx.symbol!, decimals: ctx.decimals! }
      },
    }

    const [result] = await runMultistepTasks(mockExecutor, [task])
    expect(result!.symbol).toBe('USDC')
    expect(result!.decimals).toBe(6)
  })

  it('routes results to correct task by key (multi-task)', async () => {
    const mockExecutor: StepExecutor = {
      async executeMulticall(_calls: StepCall[]): Promise<any[]> {
        return [
          // Task 1
          { status: 'success', value: 'TOK1' },
          { status: 'success', value: 18 },
          // Task 2
          { status: 'success', value: 'TOK2' },
          { status: 'success', value: 8 },
        ]
      },
    }

    const ctx1: { symbol?: string; decimals?: number } = {}
    const ctx2: { symbol?: string; decimals?: number } = {}

    const task1: MultistepTask<{ symbol: string; decimals: number }> = {
      maxStep: 1,
      buildStepCalls(step) {
        if (step !== 1) return []
        return [
          {
            key: 'symbol',
            target: '0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4',
            abi: [],
            functionName: 'symbol',
          },
          {
            key: 'decimals',
            target: '0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4',
            abi: [],
            functionName: 'decimals',
          },
        ]
      },
      consumeStepResults(_step, results) {
        for (const r of results) {
          if (r.key === 'symbol') ctx1.symbol = r.value as string
          if (r.key === 'decimals') ctx1.decimals = Number(r.value)
        }
      },
      finalize() {
        return { symbol: ctx1.symbol!, decimals: ctx1.decimals! }
      },
    }

    const task2: MultistepTask<{ symbol: string; decimals: number }> = {
      maxStep: 1,
      buildStepCalls(step) {
        if (step !== 1) return []
        return [
          {
            key: 'symbol',
            target: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
            abi: [],
            functionName: 'symbol',
          },
          {
            key: 'decimals',
            target: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
            abi: [],
            functionName: 'decimals',
          },
        ]
      },
      consumeStepResults(_step, results) {
        for (const r of results) {
          if (r.key === 'symbol') ctx2.symbol = r.value as string
          if (r.key === 'decimals') ctx2.decimals = Number(r.value)
        }
      },
      finalize() {
        return { symbol: ctx2.symbol!, decimals: ctx2.decimals! }
      },
    }

    const [result1, result2] = await runMultistepTasks(mockExecutor, [task1, task2])
    expect(result1!.symbol).toBe('TOK1')
    expect(result1!.decimals).toBe(18)
    expect(result2!.symbol).toBe('TOK2')
    expect(result2!.decimals).toBe(8)
  })

  it('executes multi-step task: step2 depends on step1 results', async () => {
    let capturedBalance: bigint | undefined

    const mockExecutor: StepExecutor = {
      async executeMulticall(calls: StepCall[]): Promise<any[]> {
        // Step 1 returns balance
        if (calls[0]?.key === 'balance') {
          return [{ status: 'success', value: 1000n }]
        }
        // Step 2 uses captured balance
        return [{ status: 'success', value: 999n }]
      },
    }

    const task: MultistepTask<{ balance: bigint; assets: bigint }> = {
      maxStep: 2,
      buildStepCalls(step) {
        if (step === 1) {
          return [
            {
              key: 'balance',
              target: '0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4',
              abi: [],
              functionName: 'balanceOf',
            },
          ]
        }
        if (step === 2 && capturedBalance !== undefined) {
          return [
            {
              key: 'assets',
              target: '0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4',
              abi: [],
              functionName: 'convertToAssets',
              args: [capturedBalance],
            },
          ]
        }
        return []
      },
      consumeStepResults(step, results) {
        if (step === 1) {
          capturedBalance = results.find((r) => r.key === 'balance')?.value as bigint
        }
      },
      finalize() {
        return { balance: capturedBalance!, assets: 999n }
      },
    }

    const [result] = await runMultistepTasks(mockExecutor, [task])
    expect(result!.balance).toBe(1000n)
    expect(result!.assets).toBe(999n)
  })

  it('skips failed calls (allowFailure) and continues', async () => {
    const mockExecutor: StepExecutor = {
      async executeMulticall(_calls: StepCall[]): Promise<any[]> {
        return [
          { status: 'failure', value: undefined },
          { status: 'success', value: 6n },
        ]
      },
    }

    const ctx: { symbol?: string; decimals?: number } = {}

    const task: MultistepTask<{ symbol: string | undefined; decimals: number }> = {
      maxStep: 1,
      buildStepCalls(step) {
        if (step !== 1) return []
        return [
          {
            key: 'symbol',
            target: '0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4',
            abi: [],
            functionName: 'symbol',
          },
          {
            key: 'decimals',
            target: '0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4',
            abi: [],
            functionName: 'decimals',
          },
        ]
      },
      consumeStepResults(_step, results) {
        for (const r of results) {
          if (r.key === 'symbol') ctx.symbol = r.value as string
          if (r.key === 'decimals') ctx.decimals = Number(r.value)
        }
      },
      finalize() {
        return { symbol: ctx.symbol, decimals: ctx.decimals ?? 0 }
      },
    }

    const [result] = await runMultistepTasks(mockExecutor, [task])
    expect(result!.symbol).toBeUndefined()
    expect(result!.decimals).toBe(6)
  })

  it("batches large call sets into sequential batches and reassembles in order", async () => {
    const callLog: { keys: string[] }[] = []

    const mockExecutor: StepExecutor = {
      async executeMulticall(calls: StepCall[]): Promise<any[]> {
        callLog.push({ keys: calls.map((c) => c.key) })
        return calls.map((c) => {
  if (c.key.endsWith('-decimals')) return { status: 'success' as const, value: 6 }
  if (c.key.endsWith('-balance')) return { status: 'success' as const, value: 1000n }
  return { status: 'success' as const, value: 'TOK' + c.key.charAt(1) }
})
      },
    }

    // 5 tokens x 3 calls = 15 calls, batchSize=4 -> 4+4+4+3 = 4 batches.
    // Batch 0 (indices 0-3): t0-sym, t0-dec, t0-bal, t1-sym
    // Batch 1 (indices 4-7): t1-dec, t1-bal, t2-sym, t2-dec
    // Batch 2 (indices 8-11): t2-bal, t3-sym, t3-dec, t3-bal
    // Batch 3 (indices 12-14): t4-sym, t4-dec, t4-bal
    const tasks: MultistepTask<{ symbol: string; decimals: number; balance: bigint }>[] = []
    for (let ti = 0; ti < 5; ti++) {
      const capturedTi = ti
      const ctx: { symbol?: string; decimals?: number; balance?: bigint } = {}
      tasks.push({
        maxStep: 1,
        buildStepCalls(step) {
          if (step !== 1) return []
          return [
            { key: 't' + capturedTi + '-symbol', target: '0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4', abi: [], functionName: 'symbol' },
            { key: 't' + capturedTi + '-decimals', target: '0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4', abi: [], functionName: 'decimals' },
            { key: 't' + capturedTi + '-balance', target: '0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4', abi: [], functionName: 'balanceOf' },
          ]
        },
        consumeStepResults(_step, results) {
          for (const r of results) {
            if (r.key === 't' + capturedTi + '-symbol') ctx.symbol = r.value as string
            if (r.key === 't' + capturedTi + '-decimals') ctx.decimals = Number(r.value)
            if (r.key === 't' + capturedTi + '-balance') ctx.balance = r.value as bigint
          }
        },
        finalize() {
          return { symbol: ctx.symbol ?? '', decimals: ctx.decimals ?? 0, balance: ctx.balance ?? 0n }
        },
      })
    }

    const results = await runMultistepTasks(mockExecutor, tasks, { batchSize: 4 })

    // Verify 4 batches with correct call indices
    expect(callLog).toHaveLength(4)
    expect(callLog[0]!.keys).toEqual(['t0-symbol', 't0-decimals', 't0-balance', 't1-symbol'])
    expect(callLog[1]!.keys).toEqual(['t1-decimals', 't1-balance', 't2-symbol', 't2-decimals'])
    expect(callLog[2]!.keys).toEqual(['t2-balance', 't3-symbol', 't3-decimals', 't3-balance'])
    expect(callLog[3]!.keys).toEqual(['t4-symbol', 't4-decimals', 't4-balance'])

    // Each task received its 3 results regardless of which batch delivered them
    for (let i = 0; i < 5; i++) {
      expect(results[i]).toEqual({ symbol: 'TOK' + i, decimals: 6, balance: 1000n })
    }
  })

  it("uses default batchSize of 100 when options is omitted", async () => {
    const callLog: { count: number }[] = []

    const mockExecutor: StepExecutor = {
      async executeMulticall(calls: StepCall[]): Promise<any[]> {
        callLog.push({ count: calls.length })
        return calls.map(() => ({ status: 'success' as const, value: 'x' }))
      },
    }

    // 100 calls should fit in 1 batch with the default
    const tasks: MultistepTask<{}>[] = Array.from({ length: 100 }, (_, i) => ({
      maxStep: 1,
      buildStepCalls(step) {
        if (step !== 1) return []
        return [{ key: 'k' + i, target: '0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4', abi: [], functionName: 'symbol' }]
      },
      consumeStepResults() {},
      finalize() { return {} },
    }))

    await runMultistepTasks(mockExecutor, tasks) // no options

    expect(callLog).toHaveLength(1)
    expect(callLog[0]!.count).toBe(100)
  })

  it("throws when executor returns wrong number of results for a batch", async () => {
    const mockExecutor: StepExecutor = {
      async executeMulticall(calls: StepCall[]): Promise<any[]> {
        // Return one too few per batch
        return calls.slice(0, calls.length - 1).map(() => ({ status: 'success' as const, value: 'x' }))
      },
    }

    const task: MultistepTask<{}> = {
      maxStep: 1,
      buildStepCalls(step) {
        if (step !== 1) return []
        return [
          { key: 'a', target: '0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4', abi: [], functionName: 'symbol' },
          { key: 'b', target: '0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4', abi: [], functionName: 'decimals' },
        ]
      },
      consumeStepResults() {},
      finalize() { return {} },
    }

    await expect(runMultistepTasks(mockExecutor, [task])).rejects.toThrow(
      'StepExecutor returned 1 results for 2 calls — length mismatch',
    )
  })
})
