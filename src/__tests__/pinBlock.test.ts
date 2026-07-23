import { describe, it, expect, vi } from 'vitest'
import { parseAbi, encodeFunctionResult, encodeAbiParameters } from 'viem'
import { defineTask } from '../core/defineTask'
import { runMultistepTasks } from '../core/runMultistepTasks'
import { runSettled } from '../core/runSettled'
import { Presets } from '../core/presets'
import { Eip1193Executor } from '../engine/eip1193'
import { DominoTaskReuseError } from '../core/errors'
import type { Address, MultistepTask, StepCall, StepExecutor, RawResult, BlockParam, PinnedBlock } from '../core/types'

/**
 * F8 — `pinBlock`. Fills the two seams T9 created in `src/core/internal.ts`
 * (`validatePinCapability`/`resolvePinnedBlock`), whose pipeline positions
 * are contractual:
 *
 *   validateOptions -> rejectDuplicateInstances -> validatePinCapability
 *   -> markTasksConsumed -> resolvePinnedBlock -> executeSteps
 *
 * So: a capability/tag rejection (`validatePinCapability`) always happens
 * BEFORE consumption (task reusable afterward); a resolution/`onPin`
 * failure (`resolvePinnedBlock`) always happens AFTER consumption (task
 * stays consumed) but strictly BEFORE any `executeMulticall` dispatch.
 */

const ADDR = '0xA0b86991C6218B36C1D19D4a2e9EB004c35d5Cc4' as Address

const testAbi = [
  {
    type: 'function',
    name: 'getNum',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
] as const

/** Fresh single-call `defineTask` task — branded (single-use). */
function brandedTask(): MultistepTask<bigint | undefined> {
  return defineTask((t) => t.call({ target: ADDR, abi: testAbi, functionName: 'getNum' }))
}

/** Legacy (unbranded) two-step task — one call per step, so a 2-step run
 *  dispatches two separate physical `executeMulticall` invocations. */
function twoStepLegacyTask(): MultistepTask<{ a?: bigint; b?: bigint }> {
  const ctx: { a?: bigint; b?: bigint } = {}
  return {
    maxStep: 2,
    buildStepCalls(step) {
      if (step === 1) return [{ key: 'a', target: ADDR, abi: testAbi, functionName: 'getNum' }]
      if (step === 2) return [{ key: 'b', target: ADDR, abi: testAbi, functionName: 'getNum' }]
      return []
    },
    consumeStepResults(step, results) {
      for (const r of results) {
        if (r.status !== 'success') continue
        if (step === 1) ctx.a = r.value as bigint
        if (step === 2) ctx.b = r.value as bigint
      }
    },
    finalize() {
      return {
        ...(ctx.a !== undefined ? { a: ctx.a } : {}),
        ...(ctx.b !== undefined ? { b: ctx.b } : {}),
      }
    },
  }
}

/** One-step legacy task — for tests that don't care about step count. */
function oneStepLegacyTask(): MultistepTask<bigint | undefined> {
  let value: bigint | undefined
  return {
    maxStep: 1,
    buildStepCalls(step) {
      if (step !== 1) return []
      return [{ key: 'v', target: ADDR, abi: testAbi, functionName: 'getNum' }]
    },
    consumeStepResults(_step, results) {
      for (const r of results) if (r.status === 'success') value = r.value as bigint
    },
    finalize() {
      return value
    },
  }
}

/** Records every `executeMulticall` invocation (calls + block param) and lets
 *  the caller push labelled events (e.g. from `onPin`) into the SAME ordered
 *  log, so relative ordering between `onPin` and the first dispatched batch
 *  can be asserted directly. */
interface TrackingExecutor extends StepExecutor {
  invocations: { calls: StepCall[]; block?: BlockParam }[]
  events: string[]
}

function makeExecutor(opts: {
  getBlockNumber?: (block?: BlockParam) => Promise<bigint>
} = {}): TrackingExecutor {
  const invocations: { calls: StepCall[]; block?: BlockParam }[] = []
  const events: string[] = []
  const executor: TrackingExecutor = {
    invocations,
    events,
    async executeMulticall(calls: StepCall[], block?: BlockParam): Promise<RawResult[]> {
      events.push('executeMulticall')
      invocations.push({ calls, ...(block !== undefined ? { block } : {}) })
      return calls.map((): RawResult => ({ status: 'success', value: 1n }))
    },
  }
  if (opts.getBlockNumber) {
    executor.getBlockNumber = vi.fn(opts.getBlockNumber)
  }
  return executor
}

// ─── 1/2. Tag resolution happens exactly once, at the real Eip1193Executor level ───

const totalSupplyAbi = parseAbi(['function getNum() view returns (uint256)'])

function encodeAggregate3Result(value: bigint): string {
  const returnData = encodeFunctionResult({
    abi: totalSupplyAbi,
    functionName: 'getNum',
    result: value,
  })
  return encodeAbiParameters(
    [{ type: 'tuple[]', components: [{ name: 'success', type: 'bool' }, { name: 'returnData', type: 'bytes' }] }],
    [[{ success: true, returnData }]],
  )
}

describe('F8 pinBlock — tag resolution at the Eip1193Executor level', () => {
  it('block: { blockTag: "safe" } — eth_getBlockByNumber called exactly once for a 2-step task; every eth_call carries the resolved hex block number (+1 RT)', async () => {
    // Post-Multicall3-deployment on mainnet (14,353,601) so this exercises
    // the deployed path, not the deployless CREATE-wrapper fallback.
    const RESOLVED_HEX = `0x${(20_000_000n).toString(16)}`
    const mockResult = encodeAggregate3Result(42n)

    const provider = {
      request: vi.fn(async ({ method, params }: { method: string; params?: readonly unknown[] }) => {
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_getBlockByNumber') {
          expect(params?.[0]).toBe('safe')
          return { number: RESOLVED_HEX }
        }
        if (method === 'eth_call') return mockResult
        throw new Error(`unexpected method ${method}`)
      }),
    }

    const executor = new Eip1193Executor(provider)
    const task = twoStepLegacyTask()

    await runMultistepTasks(executor, [task], { pinBlock: true, block: { blockTag: 'safe' } })

    const calls = provider.request.mock.calls as [{ method: string; params?: readonly unknown[] }][]
    const blockByNumberCalls = calls.filter((c) => c[0].method === 'eth_getBlockByNumber')
    const ethCallCalls = calls.filter((c) => c[0].method === 'eth_call')

    expect(blockByNumberCalls).toHaveLength(1)
    expect(ethCallCalls).toHaveLength(2) // one per step

    for (const call of ethCallCalls) {
      const blockParam = call[0].params?.[1]
      expect(blockParam).toBe(RESOLVED_HEX)
    }

    // Total round-trips: 1 chainId + 1 getBlockNumber (+1 RT) + 2 eth_call.
    expect(calls).toHaveLength(4)
  })

  it('default block (absent) resolves "latest" once; all steps pinned to it', async () => {
    const RESOLVED_HEX = `0x${(21_000_000n).toString(16)}`
    const mockResult = encodeAggregate3Result(7n)

    const provider = {
      request: vi.fn(async ({ method, params }: { method: string; params?: readonly unknown[] }) => {
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_getBlockByNumber') {
          expect(params?.[0]).toBe('latest')
          return { number: RESOLVED_HEX }
        }
        if (method === 'eth_call') return mockResult
        throw new Error(`unexpected method ${method}`)
      }),
    }

    const executor = new Eip1193Executor(provider)
    const task = twoStepLegacyTask()

    await runMultistepTasks(executor, [task], { pinBlock: true })

    const calls = provider.request.mock.calls as [{ method: string; params?: readonly unknown[] }][]
    const blockByNumberCalls = calls.filter((c) => c[0].method === 'eth_getBlockByNumber')
    const ethCallCalls = calls.filter((c) => c[0].method === 'eth_call')

    expect(blockByNumberCalls).toHaveLength(1)
    expect(ethCallCalls).toHaveLength(2)
    for (const call of ethCallCalls) {
      expect(call[0].params?.[1]).toBe(RESOLVED_HEX)
    }
  })
})

// ─── 3. `pending` + pinBlock -> throws pre-consumption ───

describe('F8 pinBlock — validatePinCapability (pre-consumption)', () => {
  it('blockTag "pending" + pinBlock: true throws before consumption; the branded task is reusable afterward', async () => {
    const executor = makeExecutor({ getBlockNumber: async () => 1n })
    const task = brandedTask()

    await expect(
      runMultistepTasks(executor, [task], { pinBlock: true, block: { blockTag: 'pending' } }),
    ).rejects.toThrow(/pending/i)

    // getBlockNumber must never have been called — the pending check throws
    // before resolution is ever attempted.
    expect(executor.getBlockNumber).not.toHaveBeenCalled()
    expect(executor.invocations).toHaveLength(0)

    // Not consumed: a later, ordinary run with the SAME instance still works.
    const [result] = await runMultistepTasks(executor, [task])
    expect(result).toBe(1n)
  })

  it('runSettled: blockTag "pending" + pinBlock: true also rejects the whole call (not a settled rejection), pre-consumption', async () => {
    const executor = makeExecutor({ getBlockNumber: async () => 1n })
    const task = brandedTask()

    await expect(
      runSettled(executor, [task], { pinBlock: true, block: { blockTag: 'pending' } }),
    ).rejects.toThrow(/pending/i)

    const [settled] = await runSettled(executor, [task])
    expect(settled).toEqual({ status: 'fulfilled', value: 1n, diagnostics: { optionalFailures: [] } })
  })

  it('executor without getBlockNumber + pinBlock: true throws before consumption; same executor WITHOUT pinBlock works (additive)', async () => {
    const executor = makeExecutor() // no getBlockNumber at all
    const task = brandedTask()

    await expect(runMultistepTasks(executor, [task], { pinBlock: true })).rejects.toThrow(
      /getBlockNumber/,
    )
    expect(executor.invocations).toHaveLength(0)

    // Not consumed — and the SAME executor works fine without pinBlock.
    const [result] = await runMultistepTasks(executor, [task])
    expect(result).toBe(1n)
  })

  it('capability check fires even for an explicit blockNumber/blockHash block (predictable contract, not RPC-need-dependent)', async () => {
    const executorNoCap = makeExecutor()

    const taskA = brandedTask()
    await expect(
      runMultistepTasks(executorNoCap, [taskA], { pinBlock: true, block: { blockNumber: 5n } }),
    ).rejects.toThrow(/getBlockNumber/)
    // Not consumed.
    const [resultA] = await runMultistepTasks(executorNoCap, [taskA])
    expect(resultA).toBe(1n)

    const taskB = brandedTask()
    await expect(
      runMultistepTasks(executorNoCap, [taskB], {
        pinBlock: true,
        block: { blockHash: '0xaaaa000000000000000000000000000000000000000000000000000000000a' },
      }),
    ).rejects.toThrow(/getBlockNumber/)
    const [resultB] = await runMultistepTasks(executorNoCap, [taskB])
    expect(resultB).toBe(1n)
  })
})

// ─── 5/6. Explicit blockNumber / blockHash -> no-op, no RPC ───

describe('F8 pinBlock — resolvePinnedBlock no-op paths (explicit blockNumber/blockHash)', () => {
  it('explicit blockNumber: getBlockNumber never invoked; onPin receives { blockNumber }; executeMulticall gets the same block', async () => {
    const executor = makeExecutor({ getBlockNumber: async () => 999n })
    const task = brandedTask()
    const pins: PinnedBlock[] = []

    await runMultistepTasks(executor, [task], {
      pinBlock: true,
      block: { blockNumber: 42n },
      onPin: (b) => pins.push(b),
    })

    expect(executor.getBlockNumber).not.toHaveBeenCalled()
    expect(pins).toEqual([{ blockNumber: 42n }])
    expect(executor.invocations).toHaveLength(1)
    expect(executor.invocations[0]!.block).toEqual({ blockNumber: 42n })
  })

  const HASH = '0xbbbb000000000000000000000000000000000000000000000000000000000b' as const

  it('explicit blockHash (with requireCanonical): no RPC; executeMulticall gets the ORIGINAL param untouched; onPin receives { blockHash, requireCanonical }', async () => {
    const executor = makeExecutor({ getBlockNumber: async () => 999n })
    const task = brandedTask()
    const pins: PinnedBlock[] = []

    await runMultistepTasks(executor, [task], {
      pinBlock: true,
      block: { blockHash: HASH, requireCanonical: true },
      onPin: (b) => pins.push(b),
    })

    expect(executor.getBlockNumber).not.toHaveBeenCalled()
    expect(pins).toEqual([{ blockHash: HASH, requireCanonical: true }])
    expect(executor.invocations[0]!.block).toEqual({ blockHash: HASH, requireCanonical: true })
  })

  it('explicit blockHash (requireCanonical absent): onPin\'s PinnedBlock has NO requireCanonical key at all (Object.hasOwn false)', async () => {
    const executor = makeExecutor({ getBlockNumber: async () => 999n })
    const task = brandedTask()
    let pinned: PinnedBlock | undefined

    await runMultistepTasks(executor, [task], {
      pinBlock: true,
      block: { blockHash: HASH },
      onPin: (b) => {
        pinned = b
      },
    })

    expect(executor.invocations[0]!.block).toEqual({ blockHash: HASH })
    expect(pinned).toEqual({ blockHash: HASH })
    expect(Object.hasOwn(pinned!, 'requireCanonical')).toBe(false)
  })
})

// ─── 7. onPin: timing, gating, and throw-propagation semantics ───

describe('F8 pinBlock — onPin timing and throw semantics', () => {
  it('called exactly once, synchronously, strictly before the first executeMulticall', async () => {
    const executor = makeExecutor({
      getBlockNumber: async () => {
        executor.events.push('getBlockNumber')
        return 100n
      },
    })
    const task = twoStepLegacyTask()
    let onPinCalls = 0

    await runMultistepTasks(executor, [task], {
      pinBlock: true,
      onPin: () => {
        onPinCalls += 1
        executor.events.push('onPin')
      },
    })

    expect(onPinCalls).toBe(1)
    // getBlockNumber -> onPin -> executeMulticall (step 1) -> executeMulticall (step 2)
    expect(executor.events).toEqual(['getBlockNumber', 'onPin', 'executeMulticall', 'executeMulticall'])
  })

  it('provided but pinBlock is NOT set: onPin is never invoked', async () => {
    const executor = makeExecutor({ getBlockNumber: async () => 100n })
    const task = oneStepLegacyTask()
    const onPin = vi.fn()

    await runMultistepTasks(executor, [task], { onPin })

    expect(onPin).not.toHaveBeenCalled()
    expect(executor.getBlockNumber).not.toHaveBeenCalled()
  })

  it('onPin throws -> run() rejects with that error; task remains consumed; executeMulticall is never called', async () => {
    const executor = makeExecutor({ getBlockNumber: async () => 100n })
    const task = brandedTask()
    const boom = new Error('onPin exploded')

    await expect(
      runMultistepTasks(executor, [task], {
        pinBlock: true,
        onPin: () => {
          throw boom
        },
      }),
    ).rejects.toBe(boom)

    expect(executor.invocations).toHaveLength(0) // no multicall batch ever dispatched

    // Tasks remain consumed — a second submission of the SAME instance sees
    // the reuse error, not another onPin throw.
    await expect(runMultistepTasks(executor, [task])).rejects.toThrow(DominoTaskReuseError)
  })

  it('onPin throws -> runSettled() rejects the whole call (not a settled rejection); task remains consumed; executeMulticall never called', async () => {
    const executor = makeExecutor({ getBlockNumber: async () => 100n })
    const task = brandedTask()
    const boom = new Error('onPin exploded (settled)')

    await expect(
      runSettled(executor, [task], {
        pinBlock: true,
        onPin: () => {
          throw boom
        },
      }),
    ).rejects.toBe(boom)

    expect(executor.invocations).toHaveLength(0)
    await expect(runSettled(executor, [task])).rejects.toThrow(DominoTaskReuseError)
  })
})

// ─── 8. runSettled parity for tag-resolution-once / explicit-blockNumber / onPin-ordering ───

describe('F8 pinBlock — runSettled parity', () => {
  it('tag resolves exactly once (parity with run())', async () => {
    const executor = makeExecutor({ getBlockNumber: async () => 100n })
    const task = twoStepLegacyTask()

    const [settled] = await runSettled(executor, [task], { pinBlock: true, block: { blockTag: 'finalized' } })

    expect(settled!.status).toBe('fulfilled')
    expect(executor.getBlockNumber).toHaveBeenCalledTimes(1)
    expect(executor.invocations).toHaveLength(2)
    for (const inv of executor.invocations) expect(inv.block).toEqual({ blockNumber: 100n })
  })

  it('explicit blockNumber: no getBlockNumber invocation; onPin receives { blockNumber }', async () => {
    const executor = makeExecutor({ getBlockNumber: async () => 999n })
    const task = brandedTask()
    const pins: PinnedBlock[] = []

    const [settled] = await runSettled(executor, [task], {
      pinBlock: true,
      block: { blockNumber: 7n },
      onPin: (b) => pins.push(b),
    })

    expect(settled!.status).toBe('fulfilled')
    expect(executor.getBlockNumber).not.toHaveBeenCalled()
    expect(pins).toEqual([{ blockNumber: 7n }])
  })

  it('onPin runs exactly once, before the first executeMulticall (parity with run())', async () => {
    const executor = makeExecutor({
      getBlockNumber: async () => {
        executor.events.push('getBlockNumber')
        return 100n
      },
    })
    const task = twoStepLegacyTask()
    let onPinCalls = 0

    await runSettled(executor, [task], {
      pinBlock: true,
      onPin: () => {
        onPinCalls += 1
        executor.events.push('onPin')
      },
    })

    expect(onPinCalls).toBe(1)
    expect(executor.events).toEqual(['getBlockNumber', 'onPin', 'executeMulticall', 'executeMulticall'])
  })
})

// ─── 9. Presets.throughput composes with pinBlock ───

describe('F8 pinBlock — composes with Presets.throughput', () => {
  it('{ ...Presets.throughput, pinBlock: true } resolves the block once and runs to completion', async () => {
    const executor = makeExecutor({ getBlockNumber: async () => 555n })
    const task = brandedTask()

    const [result] = await runMultistepTasks(executor, [task], {
      ...Presets.throughput,
      pinBlock: true,
    })

    expect(result).toBe(1n)
    expect(executor.getBlockNumber).toHaveBeenCalledTimes(1)
    expect(executor.invocations[0]!.block).toEqual({ blockNumber: 555n })
  })
})
