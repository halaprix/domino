import { describe, it, expect } from 'vitest'
import { defineTask } from '../core/defineTask'
import { runMultistepTasks } from '../core/runMultistepTasks'
import { runSettled } from '../core/runSettled'
import { DominoTaskReuseError } from '../core/errors'
import { buildErc20Task, resolveErc20Token } from '../handlers/erc20'
import { buildErc4626Task } from '../handlers/erc4626'
import { MulticallResolver } from '../engine/resolver'
import type { Address, MultistepTask, StepCall, StepExecutor, RawResult } from '../core/types'

/**
 * F2 single-use guard + consumption pipeline (T9).
 *
 * Pipeline under test (see `src/core/internal.ts`):
 *   validateOptions -> rejectDuplicateInstances -> validatePinCapability
 *   -> markTasksConsumed -> resolvePinnedBlock -> executeSteps
 *
 * Only tasks carrying the internal `SINGLE_USE` brand are guarded:
 * `defineTask()` output and `buildErc20Task()`/`buildErc4626Task()` output.
 * User-authored legacy `MultistepTask` objects are never branded — that's
 * already pinned by `compat/legacy-tasks-1.0.test.ts`'s "allows reusing
 * hand-written stateless task (1.0 no reuse-guard)" test, which this suite
 * does not duplicate.
 */

const ADDR = '0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4' as Address

const testAbi = [
  {
    type: 'function',
    name: 'getNum',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
] as const

function okExecutor(): StepExecutor {
  return {
    async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
      return calls.map((): RawResult => ({ status: 'success', value: 10n }))
    },
  }
}

describe('single-use guard — defineTask tasks', () => {
  it('first run succeeds, second run (runMultistepTasks) throws DominoTaskReuseError', async () => {
    const task = defineTask((t) => t.call({ target: ADDR, abi: testAbi, functionName: 'getNum' }))
    const executor = okExecutor()

    const [result] = await runMultistepTasks(executor, [task])
    expect(result).toBe(10n)

    await expect(runMultistepTasks(executor, [task])).rejects.toThrow(DominoTaskReuseError)
  })

  it('first run succeeds, second run (runSettled) throws DominoTaskReuseError (whole call rejects, not a settled rejection)', async () => {
    const task = defineTask((t) => t.call({ target: ADDR, abi: testAbi, functionName: 'getNum' }))
    const executor = okExecutor()

    const [settled] = await runSettled(executor, [task])
    expect(settled).toEqual({ status: 'fulfilled', value: 10n, diagnostics: { optionalFailures: [] } })

    // A reuse is a programmer error, same class as an invalid batchSize —
    // it rejects the returned promise outright, it does not produce a
    // settled-but-rejected array entry.
    await expect(runSettled(executor, [task])).rejects.toThrow(DominoTaskReuseError)
  })

  it('reuse across runners: consumed via runMultistepTasks, reuse attempt via runSettled also throws', async () => {
    const task = defineTask((t) => t.call({ target: ADDR, abi: testAbi, functionName: 'getNum' }))
    const executor = okExecutor()

    await runMultistepTasks(executor, [task])
    await expect(runSettled(executor, [task])).rejects.toThrow(DominoTaskReuseError)
  })

  it('resolver.run / resolver.runSettled inherit the guard (delegation, not a separate check)', async () => {
    const executor = okExecutor()
    const resolver = new MulticallResolver(executor)

    const taskForRun = defineTask((t) => t.call({ target: ADDR, abi: testAbi, functionName: 'getNum' }))
    await resolver.run([taskForRun])
    await expect(resolver.run([taskForRun])).rejects.toThrow(DominoTaskReuseError)

    const taskForRunSettled = defineTask((t) =>
      t.call({ target: ADDR, abi: testAbi, functionName: 'getNum' }),
    )
    await resolver.runSettled([taskForRunSettled])
    await expect(resolver.runSettled([taskForRunSettled])).rejects.toThrow(DominoTaskReuseError)
  })

  it('zero-call (derive-only) task: consumed on first run even though the executor is never invoked (consumption-point regression test)', async () => {
    let executeCount = 0
    const executor: StepExecutor = {
      async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
        executeCount++
        return calls.map((): RawResult => ({ status: 'success', value: 1n }))
      },
    }

    const task = defineTask((t) => t.derive([], () => 'const-value'))
    expect(task.maxStep).toBe(0)

    const [result] = await runMultistepTasks(executor, [task])
    expect(result).toBe('const-value')
    expect(executeCount).toBe(0) // proves the guard cannot be relying on "first executor call"

    await expect(runMultistepTasks(executor, [task])).rejects.toThrow(DominoTaskReuseError)
  })
})

describe('single-use guard — built-in factory tasks', () => {
  it('buildErc20Task output: reuse throws', async () => {
    const executor: StepExecutor = {
      async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
        return calls.map((): RawResult => ({ status: 'success', value: 'USDC' }))
      },
    }

    const task = buildErc20Task({ token: ADDR })
    await runMultistepTasks(executor, [task])
    await expect(runMultistepTasks(executor, [task])).rejects.toThrow(DominoTaskReuseError)
  })

  it('buildErc4626Task output: reuse throws', async () => {
    const executor: StepExecutor = {
      async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
        return calls.map((): RawResult => ({ status: 'success', value: 'vTOK' }))
      },
    }

    const task = buildErc4626Task({ vault: ADDR })
    await runMultistepTasks(executor, [task])
    await expect(runMultistepTasks(executor, [task])).rejects.toThrow(DominoTaskReuseError)
  })

  it('resolveErc20Token builds a fresh task per call: calling it twice with the same params still works', async () => {
    const executor: StepExecutor = {
      async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
        return calls.map((c): RawResult => {
          if (c.functionName === 'symbol') return { status: 'success', value: 'USDC' }
          if (c.functionName === 'decimals') return { status: 'success', value: 6 }
          return { status: 'success', value: 0n }
        })
      },
    }

    const first = await resolveErc20Token({ client: executor, token: ADDR })
    const second = await resolveErc20Token({ client: executor, token: ADDR })
    expect(first.symbol).toBe('USDC')
    expect(second.symbol).toBe('USDC')
  })
})

describe('single-use guard — duplicate-instance-in-one-array semantics', () => {
  it('duplicate branded instance in one array throws, and does NOT consume the instance (a later single run succeeds)', async () => {
    const task = defineTask((t) => t.call({ target: ADDR, abi: testAbi, functionName: 'getNum' }))
    const executor = okExecutor()

    await expect(runMultistepTasks(executor, [task, task])).rejects.toThrow(DominoTaskReuseError)

    // The failed duplicate submission must not have consumed the instance.
    const [result] = await runMultistepTasks(executor, [task])
    expect(result).toBe(10n)
  })

  it('mixed array [already-consumed, fresh]: throws, and the FRESH instance is not consumed (a later single run with it succeeds)', async () => {
    const consumedTask = defineTask((t) => t.call({ target: ADDR, abi: testAbi, functionName: 'getNum' }))
    const freshTask = defineTask((t) => t.call({ target: ADDR, abi: testAbi, functionName: 'getNum' }))
    const executor = okExecutor()

    // Consume the first task via its own run.
    await runMultistepTasks(executor, [consumedTask])

    await expect(runMultistepTasks(executor, [consumedTask, freshTask])).rejects.toThrow(
      DominoTaskReuseError,
    )

    // freshTask must not have been marked consumed by the failed mixed submission.
    const [result] = await runMultistepTasks(executor, [freshTask])
    expect(result).toBe(10n)
  })

  it('legacy duplicate instances in one array do NOT throw (1.0 behavior pin — unbranded tasks are never reuse-guarded)', async () => {
    const executor: StepExecutor = {
      async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
        return calls.map((): RawResult => ({ status: 'success', value: 'CONSTANT' }))
      },
    }

    const legacyTask: MultistepTask<{ value: string }> = {
      maxStep: 1,
      buildStepCalls(step) {
        if (step !== 1) return []
        return [{ key: 'result', target: ADDR, abi: [], functionName: 'symbol' }]
      },
      consumeStepResults() {
        // stateless
      },
      finalize() {
        return { value: 'CONSTANT' }
      },
    }

    const [result1, result2] = await runMultistepTasks(executor, [legacyTask, legacyTask])
    expect(result1?.value).toBe('CONSTANT')
    expect(result2?.value).toBe('CONSTANT')
  })
})

describe('single-use guard — validation ordering (does-not-consume cases)', () => {
  it('invalid batchSize with a branded task throws the batchSize error, and does NOT consume the task (a later valid run succeeds)', async () => {
    const task = defineTask((t) => t.call({ target: ADDR, abi: testAbi, functionName: 'getNum' }))
    const executor = okExecutor()

    await expect(runMultistepTasks(executor, [task], { batchSize: 0 })).rejects.toThrow(
      'batchSize must be a positive integer',
    )

    const [result] = await runMultistepTasks(executor, [task])
    expect(result).toBe(10n)
  })
})

describe('single-use guard — executor rejection after consumption', () => {
  it('executor rejection under run() still leaves the task consumed: second attempt throws DominoTaskReuseError, not the transport error', async () => {
    const boom = new Error('RPC timeout')
    const executor: StepExecutor = {
      async executeMulticall(): Promise<RawResult[]> {
        throw boom
      },
    }

    const task = defineTask((t) => t.call({ target: ADDR, abi: testAbi, functionName: 'getNum' }))

    await expect(runMultistepTasks(executor, [task])).rejects.toBe(boom)

    // The task was marked consumed BEFORE the (failed) executor call — the
    // second attempt must see a reuse error, not another transport error.
    await expect(runMultistepTasks(executor, [task])).rejects.toThrow(DominoTaskReuseError)
  })
})
