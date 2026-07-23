import { describe, it, expect, expectTypeOf } from 'vitest'
import { defineTask } from '../core/defineTask'
import { runMultistepTasks } from '../core/runMultistepTasks'
import { runSettled } from '../core/runSettled'
import { dedupeKeyFor } from '../core/dedupe'
import { DominoCallError } from '../core/errors'
import { Presets } from '../core/presets'
import { encodeAbiParameters, decodeAbiParameters } from '../core/abi'
import type { Address, MultistepTask, StepCall, StepExecutor, RawResult } from '../core/types'

/**
 * F7 — within-step, cross-task call dedup. See `src/core/dedupe.ts` (key
 * computation) and `src/core/engine.ts` (grouping + result fan-out, done
 * strictly PRE-bisection). The global unhandled-rejection guard
 * (`src/__tests__/setup/unhandled-rejections.ts`) fails any test here that
 * leaks a rejection.
 */

const ADDR = '0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4' as Address
const ADDR_MIXED_CASE = ('0x' + ADDR.slice(2).toUpperCase()) as Address

/** Minimal single-arg view function — target for the "identical call" tests. */
const testAbi = [
  {
    type: 'function',
    name: 'getVal',
    stateMutability: 'view',
    inputs: [{ name: 'x', type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
  },
] as const

/**
 * Records every physical batch it's invoked with (as `StepCall[]` snapshots)
 * and resolves every call as success, with a value derived deterministically
 * from target+functionName+args — so two subscribers of a MERGED call can be
 * asserted to receive the exact same (correct) value.
 */
function makeEchoExecutor(): { executor: StepExecutor; invocations: () => StepCall[][] } {
  const invocations: StepCall[][] = []
  const executor: StepExecutor = {
    async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
      invocations.push(calls.map((c) => ({ ...c })))
      return calls.map(
        (c): RawResult => ({
          status: 'success',
          value: `${c.target.toLowerCase()}:${c.functionName}:${(c.args ?? []).map(String).join(',')}`,
        }),
      )
    },
  }
  return { executor, invocations: () => invocations }
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Identical calls merge across tasks (dedupe on) / don't (dedupe off).
// ─────────────────────────────────────────────────────────────────────────

describe('F7 dedup — identical calls across tasks', () => {
  it('two defineTask tasks with identical target+function+args -> ONE wire call under dedupe: true; both get the same value', async () => {
    const { executor, invocations } = makeEchoExecutor()
    const taskA = defineTask((t) => ({ v: t.call({ target: ADDR, abi: testAbi, functionName: 'getVal', args: [1n] }) }))
    const taskB = defineTask((t) => ({ v: t.call({ target: ADDR, abi: testAbi, functionName: 'getVal', args: [1n] }) }))

    const [resultA, resultB] = await runMultistepTasks(executor, [taskA, taskB], { dedupe: true })

    expect(invocations()).toHaveLength(1) // one batch
    expect(invocations()[0]).toHaveLength(1) // ONE wire call, not two
    expect(resultA!.v).toBe(resultB!.v)
  })

  it('the same identical call issues TWO wire calls when dedupe is off (default)', async () => {
    const { executor, invocations } = makeEchoExecutor()
    const taskA = defineTask((t) => ({ v: t.call({ target: ADDR, abi: testAbi, functionName: 'getVal', args: [1n] }) }))
    const taskB = defineTask((t) => ({ v: t.call({ target: ADDR, abi: testAbi, functionName: 'getVal', args: [1n] }) }))

    const [resultA, resultB] = await runMultistepTasks(executor, [taskA, taskB])

    expect(invocations()).toHaveLength(1)
    expect(invocations()[0]).toHaveLength(2)
    expect(resultA!.v).toBe(resultB!.v)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 2. Spec's corruption test, verbatim scenario: conflicting output ABIs for
//    identical calldata must never merge.
// ─────────────────────────────────────────────────────────────────────────

const abiSingleOut = [
  { type: 'function', name: 'getVals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const
const abiPairOut = [
  {
    type: 'function',
    name: 'getVals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }, { type: 'uint256' }],
  },
] as const

describe('F7 dedup — conflicting output ABIs never merge (spec corruption test)', () => {
  it('same calldata, conflicting output ABIs (returns uint256 vs returns (uint256,uint256)) -> TWO wire calls, each decodes correctly per its own ABI', async () => {
    const invocations: StepCall[][] = []
    const executor: StepExecutor = {
      async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
        invocations.push(calls.map((c) => ({ ...c })))
        return calls.map((c): RawResult => {
          // Real encode/decode round-trip per call, using ITS OWN abi — proves
          // no cross-contamination between the two conflicting declarations
          // (each wire call is handled entirely independently since they were
          // never merged).
          if (c.abi === abiSingleOut) {
            const data = encodeAbiParameters(abiSingleOut[0].outputs, [42n])
            const [value] = decodeAbiParameters(abiSingleOut[0].outputs, data)
            return { status: 'success', value }
          }
          const data = encodeAbiParameters(abiPairOut[0].outputs, [42n, 43n])
          const decoded = decodeAbiParameters(abiPairOut[0].outputs, data)
          return { status: 'success', value: decoded }
        })
      },
    }

    const taskA = defineTask((t) => ({ v: t.call({ target: ADDR, abi: abiSingleOut, functionName: 'getVals' }) }))
    const taskB = defineTask((t) => ({ v: t.call({ target: ADDR, abi: abiPairOut, functionName: 'getVals' }) }))

    // taskA/taskB have deliberately DIFFERENT result shapes (that's the
    // whole point — conflicting output ABIs) — `unknown` sidesteps forcing
    // runMultistepTasks' single TResult onto two genuinely different shapes.
    const [resultA, resultB] = await runMultistepTasks(executor, [taskA, taskB] as MultistepTask<unknown>[], {
      dedupe: true,
    })

    expect(invocations).toHaveLength(1)
    expect(invocations[0]).toHaveLength(2) // never merged
    expect((resultA as { v: unknown }).v).toBe(42n)
    expect((resultB as { v: unknown }).v).toEqual([42n, 43n])
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 3. Case-insensitive target merge.
// ─────────────────────────────────────────────────────────────────────────

describe('F7 dedup — case-insensitive target merge', () => {
  it('a call with target differing only by case still merges under dedupe: true', async () => {
    const { executor, invocations } = makeEchoExecutor()
    const taskA = defineTask((t) => ({ v: t.call({ target: ADDR, abi: testAbi, functionName: 'getVal', args: [1n] }) }))
    const taskB = defineTask((t) => ({
      v: t.call({ target: ADDR_MIXED_CASE, abi: testAbi, functionName: 'getVal', args: [1n] }),
    }))

    const [resultA, resultB] = await runMultistepTasks(executor, [taskA, taskB], { dedupe: true })

    expect(invocations()).toHaveLength(1)
    expect(invocations()[0]).toHaveLength(1)
    expect(resultA!.v).toBe(resultB!.v)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 4. Legacy StepCall is never merged — not even under Presets.throughput.
// ─────────────────────────────────────────────────────────────────────────

describe('F7 dedup — legacy StepCall is never merged (eligibility is per-call, not per-run)', () => {
  it('a legacy hand-authored task + a defineTask task with identical calldata, under the FULL Presets.throughput spread -> two wire calls', async () => {
    const { executor, invocations } = makeEchoExecutor()

    let legacyValue: unknown
    const legacyTask: MultistepTask<{ v: unknown }> = {
      maxStep: 1,
      buildStepCalls(step) {
        return step === 1 ? [{ key: 'legacy', target: ADDR, abi: testAbi, functionName: 'getVal', args: [1n] }] : []
      },
      consumeStepResults(_step, results) {
        const r = results.find((res) => res.key === 'legacy')
        legacyValue = r?.status === 'success' ? r.value : undefined
      },
      finalize() {
        return { v: legacyValue }
      },
    }
    const typedTask = defineTask((t) => ({ v: t.call({ target: ADDR, abi: testAbi, functionName: 'getVal', args: [1n] }) }))

    const [legacyResult, typedResult] = await runMultistepTasks(executor, [legacyTask, typedTask], {
      ...Presets.throughput,
    })

    expect(invocations()).toHaveLength(1)
    expect(invocations()[0]).toHaveLength(2) // legacy call never merges, preset or not
    expect(legacyResult!.v).toBe(typedResult!.v)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 5. Per-call `dedupe: false` override.
// ─────────────────────────────────────────────────────────────────────────

describe('F7 dedup — dedupe: false per-call override', () => {
  it('a TypedCallSpec call with dedupe: false is never merged even when the run itself has dedupe: true', async () => {
    const { executor, invocations } = makeEchoExecutor()
    const taskA = defineTask((t) => ({ v: t.call({ target: ADDR, abi: testAbi, functionName: 'getVal', args: [1n] }) }))
    const taskB = defineTask((t) => ({
      v: t.call({ target: ADDR, abi: testAbi, functionName: 'getVal', args: [1n], dedupe: false }),
    }))

    const [resultA, resultB] = await runMultistepTasks(executor, [taskA, taskB], { dedupe: true })

    expect(invocations()).toHaveLength(1)
    expect(invocations()[0]).toHaveLength(2)
    expect(resultA!.v).toBe(resultB!.v) // still correct — just via two independent wire calls
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 6. Failure fan-out — a merged group's failure reaches EVERY subscriber.
// ─────────────────────────────────────────────────────────────────────────

describe('F7 dedup — failure fan-out', () => {
  it('a merged group whose wire call resolves with a plain per-call (revert-style) failure fans out to every subscriber (runSettled)', async () => {
    const revertError = new DominoCallError('reverted', { kind: 'revert', data: '0x' })
    const executor: StepExecutor = {
      async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
        return calls.map((): RawResult => ({ status: 'failure', error: revertError }))
      },
    }
    const taskA = defineTask((t) => ({ v: t.call({ target: ADDR, abi: testAbi, functionName: 'getVal', args: [1n] }) }))
    const taskB = defineTask((t) => ({ v: t.call({ target: ADDR, abi: testAbi, functionName: 'getVal', args: [1n] }) }))

    const [settledA, settledB] = await runSettled(executor, [taskA, taskB], { dedupe: true })

    expect(settledA!.status).toBe('rejected')
    expect(settledB!.status).toBe('rejected')
    expect((settledA as { status: 'rejected'; error: unknown }).error).toBe(revertError)
    expect((settledB as { status: 'rejected'; error: unknown }).error).toBe(revertError)
  })

  it('a merged group whose wire call becomes a bisection TERMINAL (transport rejection) fans the same synthesized failure out to every subscriber (runSettled)', async () => {
    const NOISE_1 = '0x1111111111111111111111111111111111111111' as Address
    const NOISE_2 = '0x2222222222222222222222222222222222222222' as Address
    const NOISE_3 = '0x3333333333333333333333333333333333333333' as Address

    const executor: StepExecutor = {
      async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
        if (calls.some((c) => c.target.toLowerCase() === ADDR.toLowerCase())) {
          throw new Error('transport failure')
        }
        return calls.map((): RawResult => ({ status: 'success', value: 'ok' }))
      },
    }

    const taskA = defineTask((t) => ({ v: t.call({ target: ADDR, abi: testAbi, functionName: 'getVal', args: [1n] }) }))
    const taskB = defineTask((t) => ({ v: t.call({ target: ADDR, abi: testAbi, functionName: 'getVal', args: [1n] }) }))
    const noiseTaskA = defineTask((t) => ({
      v: t.call({ target: NOISE_1, abi: testAbi, functionName: 'getVal', args: [1n] }),
    }))
    const noiseTaskB = defineTask((t) => ({
      v: t.call({ target: NOISE_2, abi: testAbi, functionName: 'getVal', args: [1n] }),
    }))
    const noiseTaskC = defineTask((t) => ({
      v: t.call({ target: NOISE_3, abi: testAbi, functionName: 'getVal', args: [1n] }),
    }))

    const [settledA, settledB, settledC1, settledC2, settledC3] = await runSettled(
      executor,
      [taskA, taskB, noiseTaskA, noiseTaskB, noiseTaskC],
      { dedupe: true, batchSize: 4, maxConcurrentBatches: 1, adaptiveBatching: true },
    )

    expect(settledA!.status).toBe('rejected')
    expect(settledB!.status).toBe('rejected')
    const errA = (settledA as { status: 'rejected'; error: unknown }).error
    const errB = (settledB as { status: 'rejected'; error: unknown }).error
    expect(errA).toBeInstanceOf(DominoCallError)
    expect((errA as DominoCallError).kind).toBe('batch')
    // SAME synthesized error object fanned out to both subscribers of the
    // merged group — not two independently-constructed-but-equal errors.
    expect(errA).toBe(errB)

    expect(settledC1!.status).toBe('fulfilled')
    expect(settledC2!.status).toBe('fulfilled')
    expect(settledC3!.status).toBe('fulfilled')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 7. Dedup + bisection interplay: a poisoned UNIQUE call bisects out of a
//    wire list that also contains several merged groups — the merged
//    groups' subscribers are unaffected and all succeed.
// ─────────────────────────────────────────────────────────────────────────

describe('F7 dedup + bisection interplay', () => {
  it('merged wire list bisects around a poisoned unique call; every subscriber of the poisoned call fails, every subscriber of a merged group succeeds', async () => {
    const POISON = '0x9999999999999999999999999999999999999999' as Address
    const TOKEN_X = '0x1111111111111111111111111111111111111111' as Address
    const TOKEN_Y = '0x2222222222222222222222222222222222222222' as Address
    const TOKEN_Z = '0x3333333333333333333333333333333333333333' as Address

    const executor: StepExecutor = {
      async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
        if (calls.some((c) => c.target.toLowerCase() === POISON.toLowerCase())) {
          throw new Error('poison')
        }
        return calls.map((c): RawResult => ({ status: 'success', value: `${c.target.toLowerCase()}-ok` }))
      },
    }

    const mk = (target: Address) =>
      defineTask((t) => ({ v: t.call({ target, abi: testAbi, functionName: 'getVal', args: [1n] }) }))

    const x1 = mk(TOKEN_X)
    const x2 = mk(TOKEN_X)
    const y1 = mk(TOKEN_Y)
    const y2 = mk(TOKEN_Y)
    const z1 = mk(TOKEN_Z)
    const z2 = mk(TOKEN_Z)
    const poisoned = mk(POISON)

    const [rx1, rx2, ry1, ry2, rz1, rz2, rp] = await runSettled(executor, [x1, x2, y1, y2, z1, z2, poisoned], {
      dedupe: true,
      batchSize: 4,
      maxConcurrentBatches: 1,
      adaptiveBatching: true,
    })

    expect(rp!.status).toBe('rejected')
    for (const r of [rx1, rx2, ry1, ry2, rz1, rz2]) {
      expect(r!.status).toBe('fulfilled')
    }

    // The mock executor resolves with a string (`"<target>-ok"`), not the
    // `bigint` `getVal` is statically typed to return — irrelevant here,
    // this test only cares about routing, not decoding — hence the
    // `unknown` bounce through before re-asserting the concrete shape.
    const valueOf = (r: unknown): string => (r as { status: 'fulfilled'; value: { v: string } }).value.v
    expect(valueOf(rx1)).toBe(`${TOKEN_X.toLowerCase()}-ok`)
    expect(valueOf(rx1)).toBe(valueOf(rx2))
    expect(valueOf(ry1)).toBe(valueOf(ry2))
    expect(valueOf(rz1)).toBe(valueOf(rz2))
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 8. Hit-rate counting — fixture with known duplicates.
// ─────────────────────────────────────────────────────────────────────────

describe('F7 dedup — hit-rate counting', () => {
  it('100 portfolio entries x 3 calls each, over 10 distinct tokens -> exactly 30 unique wire calls (90% dedup hit rate)', async () => {
    const erc20LikeAbi = [
      { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
      { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
      { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
    ] as const

    const distinctTokens: Address[] = Array.from(
      { length: 10 },
      (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}` as Address,
    )

    let wireCallCount = 0
    const executor: StepExecutor = {
      async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
        wireCallCount += calls.length
        return calls.map((): RawResult => ({ status: 'success', value: 1 }))
      },
    }

    const tasks = Array.from({ length: 100 }, (_, i) => {
      const token = distinctTokens[i % 10]!
      return defineTask((t) => ({
        symbol: t.call({ target: token, abi: erc20LikeAbi, functionName: 'symbol' }),
        decimals: t.call({ target: token, abi: erc20LikeAbi, functionName: 'decimals' }),
        totalSupply: t.call({ target: token, abi: erc20LikeAbi, functionName: 'totalSupply' }),
      }))
    })

    await runMultistepTasks(executor, tasks, { dedupe: true })

    const naiveCallCount = 100 * 3
    expect(wireCallCount).toBe(30) // 10 distinct tokens x 3 calls each
    expect(1 - wireCallCount / naiveCallCount).toBeCloseTo(0.9, 5)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 9. Named vs unnamed tuple outputs -> DIFFERENT keys.
// ─────────────────────────────────────────────────────────────────────────

describe('F7 dedup — named vs unnamed tuple outputs produce different keys (canon includes names)', () => {
  it('two calls with identical calldata but tuple outputs differing only in component names produce DIFFERENT dedupeKeyFor results', () => {
    const namedTupleAbi = [
      {
        type: 'function',
        name: 'getPair',
        stateMutability: 'view',
        inputs: [],
        outputs: [
          {
            type: 'tuple',
            components: [
              { name: 'a', type: 'uint256' },
              { name: 'b', type: 'uint256' },
            ],
          },
        ],
      },
    ] as const
    const unnamedTupleAbi = [
      {
        type: 'function',
        name: 'getPair',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ type: 'tuple', components: [{ type: 'uint256' }, { type: 'uint256' }] }],
      },
    ] as const

    const namedTask = defineTask((t) => ({ v: t.call({ target: ADDR, abi: namedTupleAbi, functionName: 'getPair' }) }))
    const unnamedTask = defineTask((t) => ({
      v: t.call({ target: ADDR, abi: unnamedTupleAbi, functionName: 'getPair' }),
    }))

    const [namedCall] = namedTask.buildStepCalls(1)
    const [unnamedCall] = unnamedTask.buildStepCalls(1)

    const namedKey = dedupeKeyFor(namedCall!)
    const unnamedKey = dedupeKeyFor(unnamedCall!)

    expect(namedKey).toBeDefined()
    expect(unnamedKey).toBeDefined()
    expect(namedKey).not.toBe(unnamedKey)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 10. Presets.throughput.
// ─────────────────────────────────────────────────────────────────────────

describe('F7 — Presets.throughput', () => {
  it('deep-equals the spec literal', () => {
    expect(Presets.throughput).toEqual({ maxConcurrentBatches: 5, adaptiveBatching: true, dedupe: true })
  })

  it('is a readonly literal at the type level (as const)', () => {
    // Type-only check: this function is NEVER invoked (see below) — its body
    // exists purely so `tsc` (via `npm run typecheck`, which checks all of
    // `src`) verifies the assignment is a compile-time error regardless of
    // runtime execution. Never letting this actually run means there is no
    // risk of mutating the shared `Presets.throughput` singleton other tests
    // (and consumers) rely on.
    function typeOnlyReadonlyCheck(): void {
      // @ts-expect-error — `as const` makes every property of `Presets.throughput` readonly
      Presets.throughput.dedupe = false
    }
    expect(typeof typeOnlyReadonlyCheck).toBe('function')

    expectTypeOf(Presets.throughput).toEqualTypeOf<{
      readonly maxConcurrentBatches: 5
      readonly adaptiveBatching: true
      readonly dedupe: true
    }>()
  })
})
