import { describe, it, expect } from 'vitest'
import { runMultistepTasks } from '../core/runMultistepTasks'
import { runSettled } from '../core/runSettled'
import { DominoCallError } from '../core/errors'
import type { Address, MultistepTask, StepCall, StepResult, StepExecutor, RawResult } from '../core/types'

/**
 * F6b — adaptive bisection. See `src/core/pool.ts` (the central queue that
 * owns splitting + attempts accounting) and `src/core/engine.ts`
 * (`StepEnginePolicy.recordTerminal`, the hook that lets `runSettled` record
 * a terminal batch failure instead of triggering `run`'s fail-fast
 * cancellation). The global unhandled-rejection guard
 * (`src/__tests__/setup/unhandled-rejections.ts`) fails any test here that
 * leaks a rejection.
 */

const ADDR = '0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4' as Address

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function call(key: string): StepCall {
  return { key, target: ADDR, abi: [], functionName: 'f' }
}

/** Single-step task with `n` calls keyed `c0..c(n-1)`. */
function makeCallsTask(n: number): MultistepTask<StepResult[]> {
  let captured: StepResult[] = []
  return {
    maxStep: 1,
    buildStepCalls(step) {
      if (step !== 1) return []
      return Array.from({ length: n }, (_, i) => call('c' + i))
    },
    consumeStepResults(_step, results) {
      captured = results
    },
    finalize() {
      return captured
    },
  }
}

/**
 * An executor that rejects any physical batch CONTAINING a poisoned key (by
 * exact key match against `calls`), otherwise resolves every call as
 * `success`. Tracks total invocation count and every batch (as key arrays)
 * it was actually called with — used to assert the executor was called
 * exactly the expected number of times and never with a batch that could not
 * possibly need re-execution.
 */
function makePoisonExecutor(
  poisonedKeys: Set<string>,
  opts?: { delay?: () => number },
): { executor: StepExecutor; callCount: () => number; invocations: () => string[][] } {
  let count = 0
  const invocations: string[][] = []
  const executor: StepExecutor = {
    async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
      count++
      const keys = calls.map((c) => c.key)
      invocations.push(keys)
      if (opts?.delay) await sleep(opts.delay())
      if (keys.some((k) => poisonedKeys.has(k))) {
        throw new Error(`transport failure containing poisoned key(s): ${keys.filter((k) => poisonedKeys.has(k)).join(',')}`)
      }
      return calls.map((c): RawResult => ({ status: 'success', value: 'ok-' + c.key }))
    },
  }
  return { executor, callCount: () => count, invocations: () => invocations }
}

function findResult(results: StepResult[], key: string): StepResult | undefined {
  return results.find((r) => r.key === key)
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Isolation — 100 calls, 1 poisoned, runSettled, adaptive on.
// ─────────────────────────────────────────────────────────────────────────

describe('bisection isolation (runSettled)', () => {
  it('99 succeed, 1 kind:"batch" failure with cause identity = the last transport error; call count within default cap', async () => {
    const poisoned = 'c42'
    const { executor, callCount } = makePoisonExecutor(new Set([poisoned]))
    const task = makeCallsTask(100)

    const [settled] = await runSettled(executor, [task], {
      batchSize: 100,
      maxConcurrentBatches: 1,
      adaptiveBatching: true,
    })

    expect(settled!.status).toBe('fulfilled')
    const results = (settled as { status: 'fulfilled'; value: StepResult[] }).value
    expect(results).toHaveLength(100)

    const successes = results.filter((r) => r.status === 'success')
    const failures = results.filter((r) => r.status === 'failure')
    expect(successes).toHaveLength(99)
    expect(failures).toHaveLength(1)
    expect(failures[0]!.key).toBe(poisoned)

    const err = (failures[0] as { status: 'failure'; error?: unknown }).error
    expect(err).toBeInstanceOf(DominoCallError)
    expect((err as DominoCallError).kind).toBe('batch')
    expect((err as DominoCallError).cause).toBeInstanceOf(Error)
    expect(((err as DominoCallError).cause as Error).message).toContain(poisoned)

    // default maxBatchAttempts = 2*ceil(log2(100))+1 = 15; single-fault
    // isolation should land close to 1 + 2*ceil(log2(100)) and never exceed
    // the cap.
    const defaultCap = 2 * Math.ceil(Math.log2(100)) + 1
    expect(callCount()).toBeLessThanOrEqual(defaultCap)
    expect(callCount()).toBeGreaterThan(1) // must have actually split at least once

    // Every non-poisoned call kept its correct value.
    for (const r of successes) {
      expect((r as { status: 'success'; value: unknown }).value).toBe('ok-' + r.key)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 2. run() single-poisoned — thrown error identity, shuffled runs.
// ─────────────────────────────────────────────────────────────────────────

describe('bisection identity (run)', () => {
  it('throws the exact transport error from the final length-1 execution; stable over >=100 shuffled runs', async () => {
    const poisoned = 'c17'

    for (let i = 0; i < 100; i++) {
      let poisonError: Error | undefined
      const executor: StepExecutor = {
        async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
          await sleep(Math.random() * 5)
          const keys = calls.map((c) => c.key)
          if (keys.includes(poisoned)) {
            const err = new Error('poison-' + poisoned)
            if (keys.length === 1) poisonError = err
            throw err
          }
          return calls.map((): RawResult => ({ status: 'success', value: 1 }))
        },
      }

      const task = makeCallsTask(20)
      const conc = (i % 4) + 1 // cycle 1..4

      let thrown: unknown
      try {
        await runMultistepTasks(executor, [task], {
          batchSize: 20,
          maxConcurrentBatches: conc,
          adaptiveBatching: true,
        })
        throw new Error('expected run() to reject')
      } catch (err) {
        thrown = err
      }

      expect(poisonError).toBeDefined()
      expect(thrown).toBe(poisonError)
    }
  }, 30_000)
})

// ─────────────────────────────────────────────────────────────────────────
// 3. Attempts cap.
// ─────────────────────────────────────────────────────────────────────────

describe('attempts cap', () => {
  it('maxBatchAttempts: 3 with a 100-call poisoned batch -> <=3 executions; a coarse (>1) unresolved group fails kind "batch"; resolved calls keep exact values', async () => {
    const poisoned = 'c42'
    const { executor, callCount } = makePoisonExecutor(new Set([poisoned]))
    const task = makeCallsTask(100)

    const [settled] = await runSettled(executor, [task], {
      batchSize: 100,
      maxConcurrentBatches: 1,
      adaptiveBatching: true,
      maxBatchAttempts: 3,
    })

    expect(callCount()).toBeLessThanOrEqual(3)

    const results = (settled as { status: 'fulfilled'; value: StepResult[] }).value
    const failures = results.filter((r) => r.status === 'failure')
    const successes = results.filter((r) => r.status === 'success')

    // With only 3 executions available, full isolation to a single call is
    // impossible for a 100-call batch -> a coarse group (>1 call) remains
    // unresolved, all as kind:'batch' failures.
    expect(failures.length).toBeGreaterThan(1)
    for (const f of failures) {
      const err = (f as { status: 'failure'; error?: unknown }).error
      expect(err).toBeInstanceOf(DominoCallError)
      expect((err as DominoCallError).kind).toBe('batch')
    }
    // The poisoned call itself is always among the unresolved.
    expect(failures.some((f) => f.key === poisoned)).toBe(true)

    // Every resolved call kept its correct value (never wrong data).
    for (const r of successes) {
      expect((r as { status: 'success'; value: unknown }).value).toBe('ok-' + r.key)
    }
    expect(successes.length + failures.length).toBe(100)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 4. Deadlock.
// ─────────────────────────────────────────────────────────────────────────

describe('no pool deadlock', () => {
  it('pool of 1, poisoned batch of 100, adaptive on -> terminates with full isolation', async () => {
    const poisoned = 'c7'
    const { executor } = makePoisonExecutor(new Set([poisoned]))
    const task = makeCallsTask(100)

    const [settled] = await runSettled(executor, [task], {
      batchSize: 100,
      maxConcurrentBatches: 1,
      adaptiveBatching: true,
    })

    const results = (settled as { status: 'fulfilled'; value: StepResult[] }).value
    const failures = results.filter((r) => r.status === 'failure')
    expect(failures).toHaveLength(1)
    expect(failures[0]!.key).toBe(poisoned)
    expect(results.filter((r) => r.status === 'success')).toHaveLength(99)
  })

  it('conc=2, two original batches, one bisects -> the other original batch fully succeeds', async () => {
    const poisoned = 'poison-x'
    const poisonedBatchCalls = Array.from({ length: 50 }, (_, i) => call('p' + i))
    // Replace one call's key with the poisoned marker so the executor can
    // recognize it.
    poisonedBatchCalls[13] = call(poisoned)
    const healthyBatchCalls = Array.from({ length: 50 }, (_, i) => call('h' + i))

    const invocationKeys: string[][] = []
    const executor: StepExecutor = {
      async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
        const keys = calls.map((c) => c.key)
        invocationKeys.push(keys)
        await sleep(Math.random() * 5)
        if (keys.includes(poisoned)) throw new Error('poison')
        return calls.map((c): RawResult => ({ status: 'success', value: 'ok-' + c.key }))
      },
    }

    let capturedA: StepResult[] = []
    let capturedB: StepResult[] = []
    const taskA: MultistepTask<null> = {
      maxStep: 1,
      buildStepCalls(step) {
        return step === 1 ? poisonedBatchCalls : []
      },
      consumeStepResults(_step, results) {
        capturedA = results
      },
      finalize() {
        return null
      },
    }
    const taskB: MultistepTask<null> = {
      maxStep: 1,
      buildStepCalls(step) {
        return step === 1 ? healthyBatchCalls : []
      },
      consumeStepResults(_step, results) {
        capturedB = results
      },
      finalize() {
        return null
      },
    }

    const [resultA, resultB] = await runSettled(executor, [taskA, taskB], {
      batchSize: 50,
      maxConcurrentBatches: 2,
      adaptiveBatching: true,
    })

    expect(resultA!.status).toBe('fulfilled')
    expect(resultB!.status).toBe('fulfilled')

    // Batch B (healthy, separate original batch) — every call succeeded.
    expect(capturedB).toHaveLength(50)
    expect(capturedB.every((r) => r.status === 'success')).toBe(true)
    for (const c of healthyBatchCalls) {
      expect(findResult(capturedB, c.key)).toEqual({ status: 'success', key: c.key, value: 'ok-' + c.key })
    }

    // Batch A isolated its single poisoned call.
    expect(capturedA.filter((r) => r.status === 'failure')).toHaveLength(1)
    expect(findResult(capturedA, poisoned)?.status).toBe('failure')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 5. Reverts are per-call, never retried as transport failures.
// ─────────────────────────────────────────────────────────────────────────

describe('reverts not retried', () => {
  it('a resolving multicall with per-call (allowFailure-style) failures -> executor called once, zero splits', async () => {
    let callCount = 0
    const executor: StepExecutor = {
      async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
        callCount++
        return calls.map((c, i): RawResult =>
          i === 3 ? { status: 'failure', error: new Error('reverted: ' + c.key) } : { status: 'success', value: 'ok-' + c.key },
        )
      },
    }
    const task = makeCallsTask(10)

    const results = await runMultistepTasks(executor, [task], {
      batchSize: 10,
      maxConcurrentBatches: 1,
      adaptiveBatching: true,
    })

    expect(callCount).toBe(1)
    const [taskResults] = results
    expect(taskResults!.filter((r) => r.status === 'failure')).toHaveLength(1)
    expect(taskResults!.filter((r) => r.status === 'success')).toHaveLength(9)
    expect(findResult(taskResults!, 'c3')?.status).toBe('failure')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 6. Multi-poisoned (run) — some error thrown, no unhandled rejections.
// ─────────────────────────────────────────────────────────────────────────

describe('multi-poisoned (run)', () => {
  it('2 poisoned calls in different halves, adaptive on -> some error thrown; no unhandled rejections', async () => {
    for (let i = 0; i < 10; i++) {
      const poisonedA = 'c3'
      const poisonedB = 'c14'
      const executor: StepExecutor = {
        async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
          await sleep(Math.random() * 5)
          const keys = calls.map((c) => c.key)
          if (keys.includes(poisonedA) || keys.includes(poisonedB)) {
            throw new Error('poison')
          }
          return calls.map((): RawResult => ({ status: 'success', value: 1 }))
        },
      }
      const task = makeCallsTask(20)

      let rejected = false
      let thrown: unknown
      try {
        await runMultistepTasks(executor, [task], {
          batchSize: 20,
          maxConcurrentBatches: 3,
          adaptiveBatching: true,
        })
      } catch (err) {
        rejected = true
        thrown = err
      }
      expect(rejected).toBe(true)
      expect(thrown).toBeInstanceOf(Error)
    }
  }, 20_000)
})

// ─────────────────────────────────────────────────────────────────────────
// 7. Adaptive off — T14 behavior exactly, zero splits.
// ─────────────────────────────────────────────────────────────────────────

describe('adaptive off (default)', () => {
  it('a length>1 transport rejection triggers NO splits — executor called exactly once for that batch (run)', async () => {
    let callCount = 0
    const boom = new Error('boom')
    const executor: StepExecutor = {
      async executeMulticall(): Promise<RawResult[]> {
        callCount++
        throw boom
      },
    }
    const task = makeCallsTask(10)

    await expect(runMultistepTasks(executor, [task], { batchSize: 10, maxConcurrentBatches: 1 })).rejects.toBe(boom)
    expect(callCount).toBe(1)
  })

  it('a length>1 transport rejection triggers NO splits — T14 batch-failure shape exactly (runSettled)', async () => {
    let callCount = 0
    const boom = new Error('boom')
    const executor: StepExecutor = {
      async executeMulticall(): Promise<RawResult[]> {
        callCount++
        throw boom
      },
    }
    const task = makeCallsTask(10)

    const [settled] = await runSettled(executor, [task], { batchSize: 10, maxConcurrentBatches: 1 })
    expect(callCount).toBe(1)
    const results = (settled as { status: 'fulfilled'; value: StepResult[] }).value
    expect(results).toHaveLength(10)
    for (const r of results) {
      expect(r.status).toBe('failure')
      const err = (r as { status: 'failure'; error?: unknown }).error
      expect(err).toBeInstanceOf(DominoCallError)
      expect((err as DominoCallError).kind).toBe('batch')
      expect((err as DominoCallError).cause).toBe(boom)
    }
  })

  it('explicit adaptiveBatching: false behaves identically to omitted (still no splits)', async () => {
    let callCount = 0
    const boom = new Error('boom')
    const executor: StepExecutor = {
      async executeMulticall(): Promise<RawResult[]> {
        callCount++
        throw boom
      },
    }
    const task = makeCallsTask(10)

    await expect(
      runMultistepTasks(executor, [task], { batchSize: 10, maxConcurrentBatches: 1, adaptiveBatching: false }),
    ).rejects.toBe(boom)
    expect(callCount).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 8. Length-mismatch (programmer error) — still aborts, never retried.
// ─────────────────────────────────────────────────────────────────────────

describe('length-mismatch is never retried, even under adaptive', () => {
  it('run(): aborts immediately, executor called exactly once', async () => {
    let callCount = 0
    const executor: StepExecutor = {
      async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
        callCount++
        return calls.slice(0, calls.length - 1).map((): RawResult => ({ status: 'success', value: 1 }))
      },
    }
    const task = makeCallsTask(10)

    await expect(
      runMultistepTasks(executor, [task], { batchSize: 10, maxConcurrentBatches: 1, adaptiveBatching: true }),
    ).rejects.toThrow('length mismatch')
    expect(callCount).toBe(1)
  })

  it('runSettled(): aborts the entire run (rejects), executor called exactly once', async () => {
    let callCount = 0
    const executor: StepExecutor = {
      async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
        callCount++
        return calls.slice(0, calls.length - 1).map((): RawResult => ({ status: 'success', value: 1 }))
      },
    }
    const task = makeCallsTask(10)

    await expect(
      runSettled(executor, [task], { batchSize: 10, maxConcurrentBatches: 1, adaptiveBatching: true }),
    ).rejects.toThrow('length mismatch')
    expect(callCount).toBe(1)
  })
})
