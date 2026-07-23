import { describe, it, expect } from 'vitest'
import { runMultistepTasks, resolveErc20Token } from '../../index'
import type { MultistepTask, StepExecutor, StepCall } from '../../index'

/**
 * 1.0-consumer compat — do not modernize these tests; they must keep passing on every 1.x release.
 *
 * Pattern: failure semantics 1.0
 * - Call with { status: 'failure' } → handler yields undefined fields, sibling calls succeed
 * - batchSize: 0 throws
 * - Executor length-mismatch throws
 * - Executor rejection propagates (batch failure throws through)
 */

describe('Failure semantics 1.0', () => {
  it('skips failed calls and yields undefined; siblings succeed', async () => {
    // Simulates a call failure (revert, timeout, etc.)
    const mockExecutor: StepExecutor = {
      async executeMulticall(): Promise<any[]> {
        return [
          { status: 'failure' }, // symbol call failed
          { status: 'success', value: 6n }, // decimals success
          { status: 'success', value: 1000n }, // balance success
        ]
      },
    }

    const result = await resolveErc20Token({
      client: mockExecutor,
      token: '0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4',
      owner: '0x1234567890123456789012345678901234567890',
    })

    // Failed symbol → undefined; successful calls return values
    expect(result.symbol).toBeUndefined()
    expect(result.decimals).toBe(6)
    expect(result.balance).toBe(1000n)
  })

  it('allows batchSize > 0 and rejects batchSize <= 0', async () => {
    const mockExecutor: StepExecutor = {
      async executeMulticall(): Promise<any[]> {
        return [{ status: 'success', value: 'USDC' }]
      },
    }

    const makeTask = (): MultistepTask<Record<string, never>> => ({
      maxStep: 1,
      buildStepCalls(step) {
        if (step !== 1) return []
        return [
          {
            key: 'a',
            target: '0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4',
            abi: [],
            functionName: 'symbol',
          },
        ]
      },
      consumeStepResults() {},
      finalize() {
        return {}
      },
    })

    // batchSize: 0 should reject
    await expect(
      runMultistepTasks(mockExecutor, [makeTask()], { batchSize: 0 }),
    ).rejects.toThrow('batchSize must be a positive integer')

    // batchSize: -1 should reject
    await expect(
      runMultistepTasks(mockExecutor, [makeTask()], { batchSize: -1 }),
    ).rejects.toThrow('batchSize must be a positive integer')

    // batchSize: 1 should succeed
    const [result] = await runMultistepTasks(mockExecutor, [makeTask()], { batchSize: 1 })
    expect(result).toBeDefined()
  })

  it('rejects when executor returns wrong number of results', async () => {
    const mockExecutor: StepExecutor = {
      async executeMulticall(calls: StepCall[]): Promise<any[]> {
        // Return one too few — length mismatch
        return calls.slice(0, calls.length - 1).map(() => ({ status: 'success' as const, value: 'x' }))
      },
    }

    const task: MultistepTask<Record<string, never>> = {
      maxStep: 1,
      buildStepCalls(step) {
        if (step !== 1) return []
        return [
          { key: 'a', target: '0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4', abi: [], functionName: 'symbol' },
          { key: 'b', target: '0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4', abi: [], functionName: 'decimals' },
        ]
      },
      consumeStepResults() {},
      finalize() {
        return {}
      },
    }

    await expect(runMultistepTasks(mockExecutor, [task])).rejects.toThrow(
      'StepExecutor returned 1 results for 2 calls — length mismatch',
    )
  })

  it('propagates executor rejection as batch failure (1.0 semantics)', async () => {
    const mockExecutor: StepExecutor = {
      async executeMulticall(): Promise<any[]> {
        // Executor rejects — batch failure propagates unchanged
        throw new Error('RPC timeout')
      },
    }

    const task: MultistepTask<Record<string, never>> = {
      maxStep: 1,
      buildStepCalls(step) {
        if (step !== 1) return []
        return [
          { key: 'a', target: '0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4', abi: [], functionName: 'symbol' },
        ]
      },
      consumeStepResults() {},
      finalize() {
        return {}
      },
    }

    await expect(runMultistepTasks(mockExecutor, [task])).rejects.toThrow('RPC timeout')
  })

  it('skips step 2 when step 1 yields required failures', async () => {
    let step2CallCount = 0

    const mockExecutor: StepExecutor = {
      async executeMulticall(calls: StepCall[]): Promise<any[]> {
        if (calls[0]?.key === 'balance') {
          // Step 1: balance call fails
          return [{ status: 'failure' }]
        }
        // Step 2 would be here but shouldn't be called
        step2CallCount++
        return [{ status: 'success', value: 999n }]
      },
    }

    let balance: bigint | undefined

    const task: MultistepTask<{ balance: bigint | undefined; assets: bigint | undefined }> = {
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
        if (step === 2 && balance !== undefined) {
          return [
            {
              key: 'assets',
              target: '0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4',
              abi: [],
              functionName: 'convertToAssets',
              args: [balance],
            },
          ]
        }
        return []
      },
      consumeStepResults(step, results) {
        if (step === 1) {
          const r = results.find((r) => r.key === 'balance' && r.status === 'success')
          balance = r?.status === 'success' ? (r.value as bigint) : undefined
        }
      },
      finalize() {
        return { balance, assets: undefined }
      },
    }

    const [result] = await runMultistepTasks(mockExecutor, [task])
    expect(result?.balance).toBeUndefined() // Failed in step 1
    expect(step2CallCount).toBe(0) // Step 2 was never called (no balance to convert)
  })
})
