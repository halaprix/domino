import { describe, it, expect } from 'vitest'
import { runMultistepTasks } from '@halaprix/domino'
import type { MultistepTask, StepExecutor, StepCall, StepResult, RawResult } from '@halaprix/domino'

/**
 * 1.0-consumer compat — do not modernize these tests; they must keep passing on every 1.x release.
 *
 * Pattern: hand-written legacy MultistepTask
 * - Consumer-authored plain-object task with closure ctx, 2 steps
 * - Second step consumes first step's result
 * - Stateless task (buildStepCalls pure, finalize constant) run TWICE
 * - Validates 1.0 allows reusing hand-written tasks (no reuse-guard in 1.0)
 */

describe('Legacy hand-written MultistepTask with closure context', () => {
  it('executes multi-step task with step dependencies via closure', async () => {
    let capturedBalance: bigint | undefined

    const mockExecutor: StepExecutor = {
      async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
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
          const r = results.find((r) => r.key === 'balance' && r.status === 'success')
          capturedBalance = r?.status === 'success' ? (r.value as bigint) : undefined
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

  it('allows reusing hand-written stateless task (1.0 no reuse-guard)', async () => {
    // 1.0 does NOT prevent reusing user-authored tasks; 1.1 adds explicit guards
    // This test pins that 1.0 allows it (even if it's not recommended)

    const mockExecutor: StepExecutor = {
      async executeMulticall(_calls: StepCall[]): Promise<RawResult[]> {
        return [{ status: 'success', value: 'CONSTANT' }]
      },
    }

    const statelessTask: MultistepTask<{ value: string }> = {
      maxStep: 1,
      buildStepCalls(step) {
        if (step !== 1) return []
        return [
          {
            key: 'result',
            target: '0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4',
            abi: [],
            functionName: 'symbol',
          },
        ]
      },
      consumeStepResults() {
        // No-op for this stateless task
      },
      finalize() {
        // Always returns the same value
        return { value: 'CONSTANT' }
      },
    }

    // First run
    const [result1] = await runMultistepTasks(mockExecutor, [statelessTask])
    expect(result1?.value).toBe('CONSTANT')

    // Second run with the SAME task object — 1.0 allows this
    const [result2] = await runMultistepTasks(mockExecutor, [statelessTask])
    expect(result2?.value).toBe('CONSTANT')
  })
})

describe('Hand-written task run via runMultistepTasks directly', () => {
  it('routes results correctly with manual key-based result assignment', async () => {
    const mockExecutor: StepExecutor = {
      async executeMulticall(_calls: StepCall[]): Promise<RawResult[]> {
        return [
          { status: 'success', value: 'TOK1' },
          { status: 'success', value: 18 },
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
      consumeStepResults(_step, results: StepResult[]) {
        for (const r of results) {
          if (r.status === 'failure') continue
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
      consumeStepResults(_step, results: StepResult[]) {
        for (const r of results) {
          if (r.status === 'failure') continue
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
})
