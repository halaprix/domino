import { describe, it, expect, vi } from 'vitest'
import { runMultistepTasks } from '../core/runMultistepTasks'
import { runSettled } from '../core/runSettled'
import { runBatchPool } from '../core/pool'
import { defineTask } from '../core/defineTask'
import { DominoCallError } from '../core/errors'
import type { Address, MultistepTask, StepCall, StepResult, StepExecutor, RawResult } from '../core/types'
import type { BatchOptions } from '../core/runMultistepTasks'

/**
 * F6a — concurrency pool + fail-fast cancellation.
 *
 * See `src/core/pool.ts` (the concurrency primitive) and
 * `src/core/engine.ts` (the shared step loop `run`/`runSettled` now both
 * drive) for the design this suite pins. The global unhandled-rejection
 * guard (`src/__tests__/setup/unhandled-rejections.ts`) fails any test in
 * this file (or any other) that leaks a rejection — several assertions
 * below rely on it instead of re-implementing their own leak detection.
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function call(key: string): StepCall {
  return { key, target: ADDR, abi: [], functionName: 'f' }
}

/** A single-step task with `n` calls keyed `c0..c(n-1)`. Captures whatever
 *  it's given via consumeStepResults so tests can assert routing/dead-ness. */
function makeCallsTask(
  n: number,
  opts?: { onConsume?: (step: number, results: StepResult[]) => void },
): MultistepTask<StepResult[]> {
  let captured: StepResult[] = []
  return {
    maxStep: 1,
    buildStepCalls(step) {
      if (step !== 1) return []
      return Array.from({ length: n }, (_, i) => call('c' + i))
    },
    consumeStepResults(step, results) {
      captured = results
      opts?.onConsume?.(step, results)
    },
    finalize() {
      return captured
    },
  }
}

function okExecutor(): StepExecutor {
  return {
    async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
      return calls.map((): RawResult => ({ status: 'success', value: 10n }))
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Concurrency observation — external review (P2): absolute wall-clock
// deadlines flake on loaded CI. Primary assertions observe concurrency
// directly (max in-flight, dispatch order) via an instrumented executor;
// exactly ONE relative wall-clock sanity check remains, self-calibrated
// against a same-test serial baseline instead of an absolute deadline.
// ─────────────────────────────────────────────────────────────────────────

/** Parses the flat call index back out of a `makeCallsTask` key ('c123' -> 123). */
function callIndex(key: string): number {
  return Number(key.slice(1))
}

/**
 * Executor that tracks observed in-flight concurrency and the order batches
 * were CLAIMED (start of `executeMulticall`, before its artificial delay) —
 * derives each call's original batch index from its flat call index and the
 * `batchSize` the test is about to use, so it works for any fixture built
 * from `makeCallsTask`.
 */
function makeConcurrencyProbeExecutor(
  batchSize: number,
  delayMs: number,
): { executor: StepExecutor; maxInFlight: () => number; dispatchOrder: number[] } {
  let inFlight = 0
  let observedMax = 0
  const dispatchOrder: number[] = []

  const executor: StepExecutor = {
    async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
      dispatchOrder.push(Math.floor(callIndex(calls[0]!.key) / batchSize))
      inFlight++
      observedMax = Math.max(observedMax, inFlight)
      await sleep(delayMs)
      inFlight--
      return calls.map((): RawResult => ({ status: 'success', value: 1 }))
    },
  }

  return { executor, maxInFlight: () => observedMax, dispatchOrder }
}

describe('observed concurrency', () => {
  it('conc=5: max observed in-flight is 5, batches claimed in ascending index order', async () => {
    const { executor, maxInFlight, dispatchOrder } = makeConcurrencyProbeExecutor(100, 15)
    const task = makeCallsTask(600)

    await runMultistepTasks(executor, [task], { batchSize: 100, maxConcurrentBatches: 5 })

    expect(maxInFlight()).toBe(5)
    // 600/100 = 6 batches; the 6th is only claimed once one of the first 5
    // frees up, so it can only ever be dispatched last — the full order is
    // deterministic regardless of which of the 5 finishes first.
    expect(dispatchOrder).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('conc=1 (default): max observed in-flight is 1, batches claimed strictly in order', async () => {
    const { executor, maxInFlight, dispatchOrder } = makeConcurrencyProbeExecutor(100, 5)
    const task = makeCallsTask(600)

    await runMultistepTasks(executor, [task], { batchSize: 100, maxConcurrentBatches: 1 })

    expect(maxInFlight()).toBe(1)
    expect(dispatchOrder).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('relative wall-clock sanity: conc=5 is meaningfully faster than conc=1 for the same fixture (self-calibrated, no absolute deadline)', async () => {
    const latencyMs = 50
    function makeLatencyExecutor(): StepExecutor {
      return {
        async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
          await sleep(latencyMs)
          return calls.map((): RawResult => ({ status: 'success', value: 1 }))
        },
      }
    }

    const serialStart = performance.now()
    await runMultistepTasks(makeLatencyExecutor(), [makeCallsTask(600)], {
      batchSize: 100,
      maxConcurrentBatches: 1,
    })
    const serialElapsed = performance.now() - serialStart

    const parallelStart = performance.now()
    await runMultistepTasks(makeLatencyExecutor(), [makeCallsTask(600)], {
      batchSize: 100,
      maxConcurrentBatches: 5,
    })
    const parallelElapsed = performance.now() - parallelStart

    // 6 batches: serial ~6 waves, conc=5 ~2 waves — expect roughly a 3x
    // speedup. Assert well under that (< 0.6x serial) so ordinary CI jitter
    // on either measurement can never flip the comparison.
    expect(parallelElapsed).toBeLessThan(serialElapsed * 0.6)
  }, 20_000)
})

// ─────────────────────────────────────────────────────────────────────────
// 2. Routing fuzz — completion-order-independent, index-based routing.
// ─────────────────────────────────────────────────────────────────────────

describe('routing fuzz', () => {
  /** 3 tasks x 2 steps, distinguishable keys — fresh closures every call. */
  function makeFixtureTasks(): MultistepTask<Record<string, string>>[] {
    return [0, 1, 2].map((taskIdx) => {
      const captured: Record<string, string> = {}
      return {
        maxStep: 2,
        buildStepCalls(step) {
          if (step === 1) return [0, 1, 2].map((i) => call(`t${taskIdx}-s1-${i}`))
          if (step === 2) return [0, 1].map((i) => call(`t${taskIdx}-s2-${i}`))
          return []
        },
        consumeStepResults(_step, results) {
          for (const r of results) {
            if (r.status === 'success') captured[r.key] = r.value as string
          }
        },
        finalize() {
          return captured
        },
      }
    })
  }

  function fuzzExecutor(maxDelayMs: number): StepExecutor {
    return {
      async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
        if (maxDelayMs > 0) await sleep(Math.random() * maxDelayMs)
        return calls.map((c): RawResult => ({ status: 'success', value: 'v-' + c.key }))
      },
    }
  }

  it('20+ runs with random per-batch delays at conc=4 match the serial (conc=1) reference exactly', async () => {
    const reference = await runMultistepTasks(fuzzExecutor(0), makeFixtureTasks(), {
      batchSize: 2,
      maxConcurrentBatches: 1,
    })

    for (let i = 0; i < 25; i++) {
      const fuzzed = await runMultistepTasks(fuzzExecutor(20), makeFixtureTasks(), {
        batchSize: 2,
        maxConcurrentBatches: 4,
      })
      expect(fuzzed).toEqual(reference)
    }
  }, 20_000)
})

// ─────────────────────────────────────────────────────────────────────────
// 3-6. Fail-fast cancellation — spec (a)-(d).
// ─────────────────────────────────────────────────────────────────────────

describe('fail-fast cancellation (run)', () => {
  it('(a) queued batches are not dispatched after the failure is discovered', async () => {
    const dispatched: string[] = []
    const boom = new Error('boom-c1')
    const executor: StepExecutor = {
      async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
        const key = calls[0]!.key
        dispatched.push(key)
        if (key === 'c1') throw boom // rejects with no delay
        await sleep(20) // c0 (and any other claimed batch) settles slower
        return calls.map((): RawResult => ({ status: 'success', value: 1 }))
      },
    }

    const task = makeCallsTask(6)
    await expect(
      runMultistepTasks(executor, [task], { batchSize: 1, maxConcurrentBatches: 2 }),
    ).rejects.toBe(boom)

    // Only batch 0 (already claimed, slower) and batch 1 (the poisoned one)
    // are ever dispatched — batches 2-5 were still queued when cancellation
    // triggered (c1 rejects long before c0's 20ms delay elapses).
    expect(dispatched.length).toBeLessThan(6)
    expect(new Set(dispatched)).toEqual(new Set(['c0', 'c1']))
  })

  it('(b)+(d) in-flight batches settle without leaking, and consumeStepResults is never called for the failing step', async () => {
    const boom = new Error('boom-c1')
    const executor: StepExecutor = {
      async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
        const key = calls[0]!.key
        if (key === 'c1') throw boom
        await sleep(20)
        return calls.map((): RawResult => ({ status: 'success', value: 1 }))
      },
    }

    const consumeSpy = vi.fn()
    const task: MultistepTask<null> = {
      maxStep: 1,
      buildStepCalls(step) {
        if (step !== 1) return []
        return Array.from({ length: 6 }, (_, i) => call('c' + i))
      },
      consumeStepResults: consumeSpy,
      finalize() {
        return null
      },
    }

    await expect(
      runMultistepTasks(executor, [task], { batchSize: 1, maxConcurrentBatches: 2 }),
    ).rejects.toBe(boom)

    // (d): the failing step's results are discarded — consumeStepResults is
    // never invoked for it. (b)'s "no unhandled rejections" half is proven
    // by the global afterEach guard, not by an assertion in this test body.
    expect(consumeSpy).not.toHaveBeenCalled()
  })

  it('(c) error-identity determinism: single poisoned batch, random delays, conc=3, >=100 runs -> same object every time', async () => {
    const boom = new Error('poison-c2')

    for (let i = 0; i < 100; i++) {
      const executor: StepExecutor = {
        async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
          await sleep(Math.random() * 20)
          if (calls[0]!.key === 'c2') throw boom
          return calls.map((): RawResult => ({ status: 'success', value: 1 }))
        },
      }
      const task = makeCallsTask(6)

      await expect(
        runMultistepTasks(executor, [task], { batchSize: 1, maxConcurrentBatches: 3 }),
      ).rejects.toBe(boom)
    }
  }, 30_000)

  it('multi-poisoned fixture: thrown error is one of the poisoned batches\' errors; no unhandled rejections', async () => {
    const errC1 = new Error('boom-c1')
    const errC4 = new Error('boom-c4')

    for (let i = 0; i < 10; i++) {
      const executor: StepExecutor = {
        async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
          await sleep(Math.random() * 20)
          const key = calls[0]!.key
          if (key === 'c1') throw errC1
          if (key === 'c4') throw errC4
          return calls.map((): RawResult => ({ status: 'success', value: 1 }))
        },
      }
      const task = makeCallsTask(6)

      let thrown: unknown
      let rejected = false
      try {
        await runMultistepTasks(executor, [task], { batchSize: 1, maxConcurrentBatches: 3 })
      } catch (err) {
        rejected = true
        thrown = err
      }
      expect(rejected).toBe(true)
      // Identity is explicitly UNSPECIFIED for multi-failure — only assert
      // membership, never which one.
      expect([errC1, errC4]).toContain(thrown)
    }
  }, 20_000)
})

// ─────────────────────────────────────────────────────────────────────────
// 7. runSettled never cancels — record-and-continue under concurrency.
// ─────────────────────────────────────────────────────────────────────────

describe('runSettled concurrency (never cancels)', () => {
  it('poisoned batch among 6 (conc=3): ALL 6 batches dispatched, non-poisoned calls succeed, later step still runs', async () => {
    const boom = new Error('transport down')
    const dispatched: string[] = []

    const executor: StepExecutor = {
      async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
        const key = calls[0]!.key
        dispatched.push(key)
        await sleep(Math.random() * 15)
        if (key === 'a1') throw boom
        return calls.map((): RawResult => ({ status: 'success', value: 'ok-' + key }))
      },
    }

    let step2Built = false
    let taskAStep1: StepResult[] = []
    let taskAStep2: StepResult[] = []
    let taskBStep1: StepResult[] = []

    const taskA: MultistepTask<{ step1: StepResult[]; step2: StepResult[] }> = {
      maxStep: 2,
      buildStepCalls(step) {
        if (step === 1) return ['a0', 'a1', 'a2'].map(call)
        if (step === 2) {
          step2Built = true
          return [call('a-final')]
        }
        return []
      },
      consumeStepResults(step, results) {
        if (step === 1) taskAStep1 = results
        if (step === 2) taskAStep2 = results
      },
      finalize() {
        return { step1: taskAStep1, step2: taskAStep2 }
      },
    }

    const taskB: MultistepTask<{ step1: StepResult[] }> = {
      maxStep: 1,
      buildStepCalls(step) {
        if (step !== 1) return []
        return ['b0', 'b1', 'b2'].map(call)
      },
      consumeStepResults(step, results) {
        if (step === 1) taskBStep1 = results
      },
      finalize() {
        return { step1: taskBStep1 }
      },
    }

    const [resultA, resultB] = await runSettled(executor, [taskA, taskB], {
      batchSize: 1,
      maxConcurrentBatches: 3,
    })

    // ALL 6 step-1 batches dispatched — never cancels. (`dispatched` also
    // picks up step 2's single call once that step runs; filter it out to
    // check step 1 specifically — step 2 running at all is asserted below.)
    const step1Dispatched = dispatched.filter((k) => k !== 'a-final').sort()
    expect(step1Dispatched).toEqual(['a0', 'a1', 'a2', 'b0', 'b1', 'b2'])
    expect(step2Built).toBe(true)
    expect(resultA!.status).toBe('fulfilled')
    expect(resultB!.status).toBe('fulfilled')

    // Poisoned call carries a kind:'batch' DominoCallError with cause identity.
    const a1Result = taskAStep1.find((r) => r.key === 'a1')
    expect(a1Result?.status).toBe('failure')
    const a1Error = (a1Result as { status: 'failure'; error?: unknown }).error
    expect(a1Error).toBeInstanceOf(DominoCallError)
    expect((a1Error as DominoCallError).kind).toBe('batch')
    expect((a1Error as DominoCallError).cause).toBe(boom)

    // Non-poisoned calls (same task, sibling task) succeeded normally.
    expect(taskAStep1.find((r) => r.key === 'a0')).toEqual({ status: 'success', key: 'a0', value: 'ok-a0' })
    expect(taskAStep1.find((r) => r.key === 'a2')).toEqual({ status: 'success', key: 'a2', value: 'ok-a2' })
    expect(taskBStep1).toEqual([
      { status: 'success', key: 'b0', value: 'ok-b0' },
      { status: 'success', key: 'b1', value: 'ok-b1' },
      { status: 'success', key: 'b2', value: 'ok-b2' },
    ])

    // Later step (a-final) still ran and succeeded.
    expect(taskAStep2).toEqual([{ status: 'success', key: 'a-final', value: 'ok-a-final' }])
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 8. Validation — numeric fields, pre-consumption.
// ─────────────────────────────────────────────────────────────────────────

describe('validation', () => {
  const badValues = [0, -1, 1.5, NaN, 2 ** 53]

  for (const field of ['batchSize', 'maxConcurrentBatches', 'maxBatchAttempts'] as const) {
    it(`${field}: 0/-1/1.5/NaN/2^53 all throw pre-consumption; the branded task stays fresh`, async () => {
      const executor = okExecutor()
      const task = defineTask((t) => t.call({ target: ADDR, abi: testAbi, functionName: 'getNum' }))

      for (const bad of badValues) {
        await expect(
          runMultistepTasks(executor, [task], { [field]: bad } as BatchOptions),
        ).rejects.toThrow(`${field} must be a positive integer`)
      }

      // None of the invalid attempts consumed the task — a subsequent valid
      // run still succeeds (same pattern as singleUse.test.ts's "does-not-
      // consume" cases).
      const [result] = await runMultistepTasks(executor, [task])
      expect(result).toBe(10n)
    })
  }

  it('validation applies identically through runSettled (shared prepareRun)', async () => {
    const executor = okExecutor()
    const task = defineTask((t) => t.call({ target: ADDR, abi: testAbi, functionName: 'getNum' }))

    await expect(
      runSettled(executor, [task], { maxConcurrentBatches: 0 }),
    ).rejects.toThrow('maxConcurrentBatches must be a positive integer')

    const [settled] = await runSettled(executor, [task])
    expect(settled).toEqual({ status: 'fulfilled', value: 10n, diagnostics: { optionalFailures: [] } })
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 9. Step barrier — concurrency window never crosses a step boundary.
// ─────────────────────────────────────────────────────────────────────────

describe('step barrier under concurrency', () => {
  it('conc=5: step-2 buildStepCalls fires only after every step-1 batch has executed AND been consumed', async () => {
    const log: string[] = []

    const executor: StepExecutor = {
      async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
        const key = calls[0]!.key
        if (key.startsWith('s1-')) await sleep(Math.random() * 20)
        log.push('batch-end-' + key)
        return calls.map((): RawResult => ({ status: 'success', value: 1 }))
      },
    }

    const task: MultistepTask<null> = {
      maxStep: 2,
      buildStepCalls(step) {
        if (step === 1) {
          log.push('build-1')
          return Array.from({ length: 20 }, (_, i) => call('s1-' + i))
        }
        if (step === 2) {
          log.push('build-2')
          return [call('s2-0')]
        }
        return []
      },
      consumeStepResults(step) {
        log.push('consume-' + step)
      },
      finalize() {
        return null
      },
    }

    await runMultistepTasks(executor, [task], { batchSize: 4, maxConcurrentBatches: 5 })

    const build2Index = log.indexOf('build-2')
    const consume1Index = log.indexOf('consume-1')
    expect(build2Index).toBeGreaterThan(-1)
    expect(consume1Index).toBeGreaterThan(-1)
    expect(consume1Index).toBeLessThan(build2Index)

    // Every step-1 batch-end entry happened before consume-1 (which itself
    // happens before build-2, checked above).
    const step1BatchEnds = log.filter((e) => e.startsWith('batch-end-s1-'))
    expect(step1BatchEnds).toHaveLength(5) // 20 calls / batchSize 4
    for (const entry of step1BatchEnds) {
      expect(log.indexOf(entry)).toBeLessThan(consume1Index)
    }
  }, 10_000)
})

// ─────────────────────────────────────────────────────────────────────────
// runBatchPool — direct unit coverage (engine refactor coverage).
// ─────────────────────────────────────────────────────────────────────────

describe('runBatchPool (direct)', () => {
  it('empty batches list resolves completed with an empty results array, without calling execute', async () => {
    const execute = vi.fn()
    const outcome = await runBatchPool([], 4, execute)
    expect(outcome).toEqual({ outcome: 'completed', results: [] })
    expect(execute).not.toHaveBeenCalled()
  })

  it('clamps worker count to the number of batches (no idle over-dispatch)', async () => {
    let maxConcurrent = 0
    let current = 0
    const batches: StepCall[][] = [[call('a')], [call('b')]]
    const outcome = await runBatchPool(batches, 10, async (batch) => {
      current++
      maxConcurrent = Math.max(maxConcurrent, current)
      await sleep(5)
      current--
      return batch.map((): RawResult => ({ status: 'success', value: 1 }))
    })
    expect(outcome.outcome).toBe('completed')
    expect(maxConcurrent).toBe(2) // never exceeds batches.length even though maxConcurrentBatches=10
  })

  it('routes results by original batch index regardless of completion order', async () => {
    const batches: StepCall[][] = [[call('slow')], [call('fast')]]
    const outcome = await runBatchPool(batches, 2, async (batch) => {
      const key = batch[0]!.key
      await sleep(key === 'slow' ? 20 : 0)
      return [{ status: 'success', value: key }]
    })
    expect(outcome.outcome).toBe('completed')
    if (outcome.outcome === 'completed') {
      expect(outcome.results[0]).toEqual([{ status: 'success', value: 'slow' }])
      expect(outcome.results[1]).toEqual([{ status: 'success', value: 'fast' }])
    }
  })

  it('snapshots results at settlement — an executor reusing the SAME array/wrapper objects across batches still routes correctly (P1)', async () => {
    // Deliberately hostile: one array, one wrapper object, reused and
    // MUTATED IN PLACE for every batch. `StepExecutor` never promised a
    // fresh/immutable array per call — without the settlement-time clone in
    // `runBatchPool`, a later batch's mutation would retroactively corrupt
    // an earlier batch's already-"settled" entry once every batch shares
    // the same underlying object.
    function makeMutatingExecutor(): StepExecutor {
      const sharedWrapper: { status: 'success'; value: unknown } = { status: 'success', value: undefined }
      const sharedArray = [sharedWrapper]
      return {
        async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
          await sleep(Math.random() * 10)
          sharedWrapper.value = calls[0]!.key
          return sharedArray
        },
      }
    }

    function makeWellBehavedExecutor(): StepExecutor {
      return {
        async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
          await sleep(Math.random() * 10)
          return [{ status: 'success', value: calls[0]!.key }]
        },
      }
    }

    for (const maxConcurrentBatches of [1, 2]) {
      const wellBehaved = await runMultistepTasks(makeWellBehavedExecutor(), [makeCallsTask(6)], {
        batchSize: 1,
        maxConcurrentBatches,
      })
      const mutating = await runMultistepTasks(makeMutatingExecutor(), [makeCallsTask(6)], {
        batchSize: 1,
        maxConcurrentBatches,
      })
      expect(mutating).toEqual(wellBehaved)
    }
  })
})
