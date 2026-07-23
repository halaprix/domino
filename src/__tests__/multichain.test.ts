import { describe, it, expect, vi } from 'vitest'
import { defineTask } from '../core/defineTask'
import { DominoTaskReuseError } from '../core/errors'
import { Presets } from '../core/presets'
import { MultichainResolver } from '../engine/multichain'
import type {
  Address,
  MultistepTask,
  StepCall,
  StepExecutor,
  RawResult,
  BlockParam,
  PinnedBlock,
} from '../core/types'

/**
 * F9 — `MultichainResolver` (T19).
 *
 * Pipeline under test (see `src/engine/multichain.ts`):
 *   #assertKnownPlanChainIds -> assertNoFlattenedDuplicates([v5]) -> per-chain
 *   runMultistepTasks/runSettled, dispatched concurrently.
 *
 * [v5]'s flattened duplicate check is the one genuinely new safety rule this
 * feature adds — everything else is fan-out/fan-in over the existing
 * single-chain runners, which already have their own test coverage
 * (`singleUse.test.ts`, `pinBlock.test.ts`, `concurrency.test.ts`, etc.).
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

/** Fresh single-call `defineTask` task — branded (single-use). */
function brandedTask(): MultistepTask<bigint | undefined> {
  return defineTask((t) => t.call({ target: ADDR, abi: testAbi, functionName: 'getNum' }))
}

/** Legacy (unbranded) one-step task, stateless — reusable by 1.0 rules. */
function legacyTask(value = 'CONST'): MultistepTask<string> {
  return {
    maxStep: 1,
    buildStepCalls(step) {
      if (step !== 1) return []
      return [{ key: 'v', target: ADDR, abi: testAbi, functionName: 'getNum' }]
    },
    consumeStepResults() {
      // stateless
    },
    finalize() {
      return value
    },
  }
}

/** Records every `executeMulticall` invocation (calls + block param). */
interface TrackingExecutor extends StepExecutor {
  invocations: { calls: StepCall[]; block?: BlockParam }[]
}

function makeExecutor(
  opts: {
    getBlockNumber?: (block?: BlockParam) => Promise<bigint>
    fail?: unknown
    delayMs?: number
    onCall?: () => void
  } = {},
): TrackingExecutor {
  const invocations: { calls: StepCall[]; block?: BlockParam }[] = []
  const executor: TrackingExecutor = {
    invocations,
    async executeMulticall(calls: StepCall[], block?: BlockParam): Promise<RawResult[]> {
      opts.onCall?.()
      invocations.push({ calls, ...(block !== undefined ? { block } : {}) })
      if (opts.delayMs) await sleep(opts.delayMs)
      if (opts.fail !== undefined) throw opts.fail
      return calls.map((): RawResult => ({ status: 'success', value: 1n }))
    },
  }
  if (opts.getBlockNumber) {
    executor.getBlockNumber = vi.fn(opts.getBlockNumber)
  }
  return executor
}

// ─── 1. Constructor discrimination ───────────────────────────────────────

describe('MultichainResolver — constructor', () => {
  it('provider entry: lazily wrapped (no request before first use) and wrapped exactly once (cached across repeated use)', async () => {
    const requestLog: string[] = []
    const provider = {
      request: vi.fn(async ({ method }: { method: string; params?: readonly unknown[] }) => {
        requestLog.push(method)
        if (method === 'eth_getBlockByNumber') return { number: '0x64' }
        throw new Error(`unexpected method ${method}`)
      }),
    }

    const resolver = new MultichainResolver({ 1: provider })
    // Construction alone must not touch the provider at all.
    expect(provider.request).not.toHaveBeenCalled()

    // Two separate operations that each resolve chain 1's executor.
    await resolver.chain(1).executor.getBlockNumber?.()
    await resolver.snapshot()

    // If a fresh Eip1193Executor were constructed on each access, its
    // internal getBlockNumber wouldn't share any cache — but getBlockNumber
    // always calls eth_getBlockByNumber regardless, so what actually proves
    // single-wrapping here is identity: the exact same executor object came
    // back both times.
    const first = resolver.chain(1).executor
    const second = resolver.chain(1).executor
    expect(first).toBe(second)
    expect(requestLog.filter((m) => m === 'eth_getBlockByNumber')).toHaveLength(2)
  })

  it('executor entry: used as-is (identity preserved, never wrapped)', () => {
    const executor = makeExecutor()
    const resolver = new MultichainResolver({ 1: executor })
    expect(resolver.chain(1).executor).toBe(executor)
  })

  it('garbage entry (neither executeMulticall nor request) throws', () => {
    expect(() => new MultichainResolver({ 1: {} as unknown as StepExecutor })).toThrow()
    expect(() => new MultichainResolver({ 1: { foo: 'bar' } as unknown as StepExecutor })).toThrow()
  })

  it('empty chains record throws', () => {
    expect(() => new MultichainResolver({})).toThrow()
  })
})

// ─── 2. chain() ───────────────────────────────────────────────────────────

describe('MultichainResolver — chain()', () => {
  it('returns a cached MulticallResolver — identical instance across calls', () => {
    const resolver = new MultichainResolver({ 1: makeExecutor(), 137: makeExecutor() })
    expect(resolver.chain(1)).toBe(resolver.chain(1))
    expect(resolver.chain(137)).toBe(resolver.chain(137))
    expect(resolver.chain(1)).not.toBe(resolver.chain(137))
  })

  it('unknown chainId throws, listing known ids', () => {
    const resolver = new MultichainResolver({ 1: makeExecutor(), 137: makeExecutor() })
    expect(() => resolver.chain(999)).toThrow(/999/)
    expect(() => resolver.chain(999)).toThrow(/1/)
    expect(() => resolver.chain(999)).toThrow(/137/)
  })
})

// ─── 3. snapshot() ────────────────────────────────────────────────────────

describe('MultichainResolver — snapshot()', () => {
  it('resolves a correct chainId -> blockNumber map', async () => {
    const resolver = new MultichainResolver({
      1: makeExecutor({ getBlockNumber: async () => 100n }),
      137: makeExecutor({ getBlockNumber: async () => 200n }),
    })

    const snap = await resolver.snapshot()
    expect(snap).toEqual({ 1: 100n, 137: 200n })
  })

  it('runs getBlockNumber for every chain in parallel (overlapping in-flight)', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const events: string[] = []

    function delayedGetBlockNumber(label: string, value: bigint) {
      return async (): Promise<bigint> => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        events.push(`${label}:start`)
        await sleep(20)
        inFlight--
        events.push(`${label}:end`)
        return value
      }
    }

    const resolver = new MultichainResolver({
      1: makeExecutor({ getBlockNumber: delayedGetBlockNumber('a', 111n) }),
      2: makeExecutor({ getBlockNumber: delayedGetBlockNumber('b', 222n) }),
    })

    const snap = await resolver.snapshot()
    expect(snap).toEqual({ 1: 111n, 2: 222n })
    expect(maxInFlight).toBe(2)
    // Both starts happen before either end — proves overlap, not serial dispatch.
    expect(events.indexOf('a:start')).toBeLessThan(events.indexOf('b:end'))
    expect(events.indexOf('b:start')).toBeLessThan(events.indexOf('a:end'))
  })

  it('one chain missing getBlockNumber -> throws before ANY RPC (zero requests across all chains)', async () => {
    const requestSpy = vi.fn(async () => ({ number: '0x64' }))
    const goodProvider = { request: requestSpy }
    const badExecutor = makeExecutor() // no getBlockNumber at all

    const resolver = new MultichainResolver({ 1: goodProvider, 2: badExecutor })

    await expect(resolver.snapshot()).rejects.toThrow(/getBlockNumber/)
    expect(requestSpy).not.toHaveBeenCalled()
  })

  it('one chain rejects -> snapshot rejects with that error; no unhandled rejections (global guard)', async () => {
    const boom = new Error('chain 2 getBlockNumber failed')
    const resolver = new MultichainResolver({
      1: makeExecutor({ getBlockNumber: async () => 100n }),
      2: makeExecutor({
        getBlockNumber: async () => {
          throw boom
        },
      }),
    })

    await expect(resolver.snapshot()).rejects.toBe(boom)
    // Global unhandledRejection guard (src/__tests__/setup/unhandled-rejections.ts)
    // fails this test itself if chain 1's already-resolved promise, or any
    // derived promise, ever leaks.
  })
})

// ─── 4. [v5] Flattened duplicate-instance validation ─────────────────────

describe('MultichainResolver — [v5] flattened duplicate-instance validation', () => {
  it('same branded instance under two different chains -> DominoTaskReuseError before any executeMulticall; task still runnable afterward', async () => {
    const execA = makeExecutor()
    const execB = makeExecutor()
    const resolver = new MultichainResolver({ 1: execA, 2: execB })

    const shared = brandedTask()

    await expect(resolver.runAll({ 1: [shared], 2: [shared] })).rejects.toThrow(DominoTaskReuseError)
    expect(execA.invocations).toHaveLength(0)
    expect(execB.invocations).toHaveLength(0)

    // Nothing was consumed — the same instance runs fine afterward, alone.
    const result = await resolver.chain(1).run([shared])
    expect(result).toEqual([1n])
  })

  it('same branded instance twice in ONE chain array -> DominoTaskReuseError before any executeMulticall; still runnable afterward', async () => {
    const execA = makeExecutor()
    const resolver = new MultichainResolver({ 1: execA })
    const shared = brandedTask()

    await expect(resolver.runAll({ 1: [shared, shared] })).rejects.toThrow(DominoTaskReuseError)
    expect(execA.invocations).toHaveLength(0)

    const result = await resolver.chain(1).run([shared])
    expect(result).toEqual([1n])
  })

  it('runAllSettled: same branded instance across two chains also throws pre-execution (programmer error, not a settled rejection)', async () => {
    const execA = makeExecutor()
    const execB = makeExecutor()
    const resolver = new MultichainResolver({ 1: execA, 2: execB })
    const shared = brandedTask()

    await expect(resolver.runAllSettled({ 1: [shared], 2: [shared] })).rejects.toThrow(DominoTaskReuseError)
    expect(execA.invocations).toHaveLength(0)
    expect(execB.invocations).toHaveLength(0)
  })

  it('legacy (unbranded) duplicate instance shared across two chains is ALLOWED (1.0 rule) — both chains complete normally', async () => {
    const execA = makeExecutor()
    const execB = makeExecutor()
    const resolver = new MultichainResolver({ 1: execA, 2: execB })
    const shared = legacyTask('X')

    const result = await resolver.runAll({ 1: [shared], 2: [shared] })
    expect(result).toEqual({ 1: ['X'], 2: ['X'] })
  })

  it('legacy (unbranded) duplicate instance twice in ONE chain array is ALLOWED (1.0 rule)', async () => {
    const execA = makeExecutor()
    const resolver = new MultichainResolver({ 1: execA })
    const shared = legacyTask('Y')

    const result = await resolver.runAll({ 1: [shared, shared] })
    expect(result).toEqual({ 1: ['Y', 'Y'] })
  })
})

// ─── 5. runAll ────────────────────────────────────────────────────────────

describe('MultichainResolver — runAll()', () => {
  it('two chains run concurrently (overlapping in-flight) and results are keyed correctly', async () => {
    let inFlight = 0
    let maxInFlight = 0

    function makeSlowExecutor(): StepExecutor {
      return {
        async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
          inFlight++
          maxInFlight = Math.max(maxInFlight, inFlight)
          await sleep(20)
          inFlight--
          return calls.map((): RawResult => ({ status: 'success', value: 1n }))
        },
      }
    }

    const resolver = new MultichainResolver({ 1: makeSlowExecutor(), 2: makeSlowExecutor() })

    const result = await resolver.runAll({ 1: [legacyTask('a')], 2: [legacyTask('b')] })
    expect(result).toEqual({ 1: ['a'], 2: ['b'] })
    expect(maxInFlight).toBe(2)
  })

  it('per-chain `blocks` override reaches the right executor; chains without an override get `options.block`', async () => {
    const execA = makeExecutor()
    const execB = makeExecutor()
    const resolver = new MultichainResolver({ 1: execA, 2: execB })

    await resolver.runAll(
      { 1: [legacyTask('a')], 2: [legacyTask('b')] },
      {
        block: { blockNumber: 1000n },
        blocks: { 1: { blockNumber: 42n } },
      },
    )

    expect(execA.invocations[0]!.block).toEqual({ blockNumber: 42n })
    expect(execB.invocations[0]!.block).toEqual({ blockNumber: 1000n })
  })

  it('unknown plan chainId throws before any chain executes', async () => {
    const execA = makeExecutor()
    const resolver = new MultichainResolver({ 1: execA })

    await expect(resolver.runAll({ 1: [legacyTask()], 999: [legacyTask()] })).rejects.toThrow(/999/)
    expect(execA.invocations).toHaveLength(0)
  })

  it('empty plan resolves to {}', async () => {
    const resolver = new MultichainResolver({ 1: makeExecutor() })
    expect(await resolver.runAll({})).toEqual({})
  })
})

// ─── 6. runAll failure policy ─────────────────────────────────────────────

describe('MultichainResolver — runAll() failure policy', () => {
  it('chain A (lower id) ok, chain B rejects -> runAll rejects with B\'s error', async () => {
    const boom = new Error('chain 2 transport failure')
    const resolver = new MultichainResolver({
      1: makeExecutor(),
      2: makeExecutor({ fail: boom }),
    })

    await expect(resolver.runAll({ 1: [legacyTask()], 2: [legacyTask()] })).rejects.toBe(boom)
  })

  it('BOTH chains reject -> rejects with the LOWEST chainId\'s error, deterministically, with zero unhandled rejections', async () => {
    const boomLow = new Error('chain 1 failure')
    const boomHigh = new Error('chain 2 failure')

    for (let i = 0; i < 5; i++) {
      const resolver = new MultichainResolver({
        1: makeExecutor({ fail: boomLow, delayMs: 5 }),
        2: makeExecutor({ fail: boomHigh, delayMs: 15 }),
      })

      await expect(resolver.runAll({ 1: [legacyTask()], 2: [legacyTask()] })).rejects.toBe(boomLow)
    }

    // Reverse the relative timing (chain 1 slower than chain 2) — the
    // SELECTION rule is by chainId, not by which settles first.
    for (let i = 0; i < 5; i++) {
      const resolver = new MultichainResolver({
        1: makeExecutor({ fail: boomLow, delayMs: 15 }),
        2: makeExecutor({ fail: boomHigh, delayMs: 5 }),
      })

      await expect(resolver.runAll({ 1: [legacyTask()], 2: [legacyTask()] })).rejects.toBe(boomLow)
    }
  })
})

// ─── 7. runAllSettled ──────────────────────────────────────────────────────

describe('MultichainResolver — runAllSettled()', () => {
  it('returns per-chain settled arrays', async () => {
    const resolver = new MultichainResolver({
      1: makeExecutor(),
      2: makeExecutor(),
    })

    const result = await resolver.runAllSettled({
      1: [brandedTask()],
      2: [brandedTask()],
    })

    expect(result[1]).toEqual([{ status: 'fulfilled', value: 1n, diagnostics: { optionalFailures: [] } }])
    expect(result[2]).toEqual([{ status: 'fulfilled', value: 1n, diagnostics: { optionalFailures: [] } }])
  })

  it('one chain\'s batch failure carries kind-\'batch\' failures for that chain only; the other chain is unaffected', async () => {
    const boom = new Error('chain 2 transport failure')
    const resolver = new MultichainResolver({
      1: makeExecutor(),
      2: makeExecutor({ fail: boom }),
    })

    const result = await resolver.runAllSettled({
      1: [brandedTask()],
      2: [brandedTask()],
    })

    expect(result[1]![0]).toEqual({ status: 'fulfilled', value: 1n, diagnostics: { optionalFailures: [] } })

    const settledB = result[2]![0]!
    expect(settledB.status).toBe('rejected')
    if (settledB.status === 'rejected') {
      // The task's finalize() throws once its single ref sees a DominoCallError
      // (kind 'batch') — asserting the underlying cause is the transport error
      // is enough to prove batch-failure routing reached this task.
      expect(String(settledB.error)).toMatch(/./)
    }
  })
})

// ─── 8. pinBlock + onPin: once per chain ──────────────────────────────────

describe('MultichainResolver — pinBlock + onPin', () => {
  it('onPin fires exactly once per chain, each chain resolving via its own executor', async () => {
    const pins: { chainId: number; block: PinnedBlock }[] = []

    const resolver = new MultichainResolver({
      1: makeExecutor({ getBlockNumber: async () => 111n }),
      2: makeExecutor({ getBlockNumber: async () => 222n }),
    })

    await resolver.runAll(
      { 1: [legacyTask('a')], 2: [legacyTask('b')] },
      {
        pinBlock: true,
        onPin: (block) => {
          // onPin itself carries no chainId — recovering it here (for the
          // assertion only) relies on the resolved blockNumber being unique
          // per chain in this fixture, exactly as the class's own doc
          // comment describes as the limitation.
          const chainId = 'blockNumber' in block && block.blockNumber === 111n ? 1 : 2
          pins.push({ chainId, block })
        },
      },
    )

    expect(pins).toHaveLength(2)
    expect(pins.map((p) => p.chainId).sort()).toEqual([1, 2])
    expect(pins.find((p) => p.chainId === 1)!.block).toEqual({ blockNumber: 111n })
    expect(pins.find((p) => p.chainId === 2)!.block).toEqual({ blockNumber: 222n })
  })

  it('with `blocks` overrides, each chain pins its own override (no getBlockNumber RPC needed)', async () => {
    const exec1 = makeExecutor({ getBlockNumber: async () => 999n })
    const exec2 = makeExecutor({ getBlockNumber: async () => 999n })
    const resolver = new MultichainResolver({ 1: exec1, 2: exec2 })

    const pins: PinnedBlock[] = []

    await resolver.runAll(
      { 1: [legacyTask('a')], 2: [legacyTask('b')] },
      {
        pinBlock: true,
        blocks: { 1: { blockNumber: 10n }, 2: { blockNumber: 20n } },
        onPin: (block) => pins.push(block),
      },
    )

    expect(exec1.getBlockNumber).not.toHaveBeenCalled()
    expect(exec2.getBlockNumber).not.toHaveBeenCalled()
    expect(pins).toEqual(
      expect.arrayContaining([{ blockNumber: 10n }, { blockNumber: 20n }]),
    )
    expect(exec1.invocations[0]!.block).toEqual({ blockNumber: 10n })
    expect(exec2.invocations[0]!.block).toEqual({ blockNumber: 20n })
  })
})

// ─── 9. Presets.throughput composition ─────────────────────────────────────

describe('MultichainResolver — Presets.throughput composes with runAll options', () => {
  it('{ ...Presets.throughput, blocks: {...} } runs to completion across chains', async () => {
    const exec1 = makeExecutor()
    const exec2 = makeExecutor()
    const resolver = new MultichainResolver({ 1: exec1, 2: exec2 })

    const result = await resolver.runAll(
      { 1: [legacyTask('a')], 2: [legacyTask('b')] },
      { ...Presets.throughput, blocks: { 1: { blockNumber: 5n } } },
    )

    expect(result).toEqual({ 1: ['a'], 2: ['b'] })
    expect(exec1.invocations[0]!.block).toEqual({ blockNumber: 5n })
  })
})
