import { describe, it, expect } from 'vitest'
import { defineTask } from '../core/defineTask'
import { runMultistepTasks } from '../core/runMultistepTasks'
import { runSettled } from '../core/runSettled'
import { DominoCallError } from '../core/errors'
import type { Address, MultistepTask, StepCall, StepExecutor, StepResult, RawResult } from '../core/types'

const ADDR = '0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4' as Address
const ADDR2 = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as Address

/** Minimal test ABI covering address/uint256/string-returning view functions. */
const testAbi = [
  {
    type: 'function',
    name: 'getAddr',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'getNum',
    stateMutability: 'view',
    inputs: [{ name: 'x', type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getStr',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
] as const

describe('defineTask — depth assignment & execution', () => {
  it('call -> derive -> call chain compiles to maxStep 2 and dispatches exactly two executor invocations', async () => {
    const task = defineTask((t) => {
      const a = t.call({ target: ADDR, abi: testAbi, functionName: 'getNum', args: [1n] })
      const derived = t.derive([a], (v) => v * 2n)
      const b = t.call({ target: ADDR, abi: testAbi, functionName: 'getNum', args: [derived] })
      return { a, derived, b }
    })

    expect(task.maxStep).toBe(2)

    let executeCount = 0
    const executor: StepExecutor = {
      async executeMulticall(calls): Promise<RawResult[]> {
        executeCount++
        return calls.map((): RawResult => ({ status: 'success', value: 10n }))
      },
    }

    const [result] = await runMultistepTasks(executor, [task])

    expect(executeCount).toBe(2)
    expect(result).toEqual({ a: 10n, derived: 20n, b: 10n })
  })

  it('parallel independent calls share step 1 (single executor invocation, both calls batched)', async () => {
    const task = defineTask((t) => {
      const a = t.call({ target: ADDR, abi: testAbi, functionName: 'getStr' })
      const b = t.call({ target: ADDR2, abi: testAbi, functionName: 'getStr' })
      return { a, b }
    })

    expect(task.maxStep).toBe(1)

    const batchSizes: number[] = []
    const executor: StepExecutor = {
      async executeMulticall(calls): Promise<RawResult[]> {
        batchSizes.push(calls.length)
        return calls.map((): RawResult => ({ status: 'success', value: 'x' }))
      },
    }

    const [result] = await runMultistepTasks(executor, [task])

    expect(batchSizes).toEqual([2])
    expect(result).toEqual({ a: 'x', b: 'x' })
  })

  it('dynamic target: a step-2 call target resolves from a step-1 ref — executor receives the resolved value', async () => {
    const task = defineTask((t) => {
      const addrRef = t.call({ target: ADDR, abi: testAbi, functionName: 'getAddr' })
      const value = t.call({ target: addrRef, abi: testAbi, functionName: 'getNum', args: [1n] })
      return { value }
    })

    let getNumTarget: Address | undefined
    const executor: StepExecutor = {
      async executeMulticall(calls): Promise<RawResult[]> {
        return calls.map((c): RawResult => {
          if (c.functionName === 'getAddr') return { status: 'success', value: ADDR2 }
          getNumTarget = c.target
          return { status: 'success', value: 42n }
        })
      },
    }

    const [result] = await runMultistepTasks(executor, [task])

    expect(getNumTarget).toBe(ADDR2)
    expect(result).toEqual({ value: 42n })
  })

  it('finalize-only task (no calls at all) works — depth-0 derive resolved lazily at finalize', async () => {
    const task = defineTask((t) => {
      const c = t.derive([], () => 42)
      return { c, literal: 'x' as const }
    })

    expect(task.maxStep).toBe(0)

    const executor: StepExecutor = {
      async executeMulticall(): Promise<RawResult[]> {
        throw new Error('executor should never be invoked for a finalize-only task')
      },
    }

    const [result] = await runMultistepTasks(executor, [task])
    expect(result).toEqual({ c: 42, literal: 'x' })
  })

  it('derive fn runs exactly once even when its ref is used twice (returned shape + downstream call arg)', async () => {
    let deriveCalls = 0

    const task = defineTask((t) => {
      const a = t.call({ target: ADDR, abi: testAbi, functionName: 'getNum', args: [1n] })
      const d = t.derive([a], (v) => {
        deriveCalls++
        return v * 2n
      })
      const b = t.call({ target: ADDR, abi: testAbi, functionName: 'getNum', args: [d] })
      return { d, b }
    })

    const executor: StepExecutor = {
      async executeMulticall(calls): Promise<RawResult[]> {
        return calls.map((): RawResult => ({ status: 'success', value: 7n }))
      },
    }

    const [result] = await runMultistepTasks(executor, [task])

    expect(deriveCalls).toBe(1)
    expect(result).toEqual({ d: 14n, b: 7n })
  })
})

describe('defineTask — failure propagation', () => {
  it('skip-chain: root revert propagates transitively; cause chain shows the ROOT at every hop', async () => {
    const boom = new DominoCallError('root reverted', { kind: 'revert', data: '0x' })

    const executor: StepExecutor = {
      async executeMulticall(calls): Promise<RawResult[]> {
        return calls.map((c): RawResult => {
          const args = c.args as readonly unknown[] | undefined
          if (c.functionName === 'getNum' && args?.[0] === 1n) {
            return { status: 'failure', error: boom }
          }
          return { status: 'success', value: 99n }
        })
      },
    }

    const rootOnly = defineTask((t) => {
      const a = t.call({ target: ADDR, abi: testAbi, functionName: 'getNum', args: [1n] })
      return { a }
    })

    const oneHop = defineTask((t) => {
      const a = t.call({ target: ADDR, abi: testAbi, functionName: 'getNum', args: [1n] })
      const b = t.call({ target: ADDR, abi: testAbi, functionName: 'getNum', args: [a] })
      return { b }
    })

    const twoHop = defineTask((t) => {
      const a = t.call({ target: ADDR, abi: testAbi, functionName: 'getNum', args: [1n] })
      const b = t.call({ target: ADDR, abi: testAbi, functionName: 'getNum', args: [a] })
      const c = t.call({ target: ADDR, abi: testAbi, functionName: 'getNum', args: [b] })
      return { c }
    })

    // Each task has a distinct result shape, so `runSettled` (single TResult
    // for the whole array) is called once per task rather than batched into
    // one array literal.
    const [r1] = await runSettled(executor, [rootOnly])
    const [r2] = await runSettled(executor, [oneHop])
    const [r3] = await runSettled(executor, [twoHop])

    expect(r1!.status).toBe('rejected')
    const e1 = (r1 as { status: 'rejected'; error: unknown }).error as DominoCallError
    expect(e1).toBe(boom)
    expect(e1.kind).toBe('revert')

    expect(r2!.status).toBe('rejected')
    const e2 = (r2 as { status: 'rejected'; error: unknown }).error as DominoCallError
    expect(e2.kind).toBe('skipped')
    expect(e2.cause).toBeInstanceOf(DominoCallError)
    expect((e2.cause as DominoCallError).kind).toBe('revert')
    expect(e2.cause).toBe(boom)

    expect(r3!.status).toBe('rejected')
    const e3 = (r3 as { status: 'rejected'; error: unknown }).error as DominoCallError
    expect(e3.kind).toBe('skipped')
    const e3Cause = e3.cause as DominoCallError
    expect(e3Cause.kind).toBe('skipped')
    expect((e3Cause.cause as DominoCallError).kind).toBe('revert')
    expect(e3Cause.cause).toBe(boom)
  })

  it('derive throw -> ref FAILED with kind "derive", cause is the thrown value; dependents skip-chain', async () => {
    const thrown = new Error('derive boom')

    const task = defineTask((t) => {
      const a = t.call({ target: ADDR, abi: testAbi, functionName: 'getNum', args: [1n] })
      const d = t.derive([a], (): bigint => {
        throw thrown
      })
      return { d }
    })

    const executor: StepExecutor = {
      async executeMulticall(calls): Promise<RawResult[]> {
        return calls.map((): RawResult => ({ status: 'success', value: 5n }))
      },
    }

    const [result] = await runSettled(executor, [task])

    expect(result!.status).toBe('rejected')
    const err = (result as { status: 'rejected'; error: unknown }).error as DominoCallError
    expect(err.kind).toBe('derive')
    expect(err.cause).toBe(thrown)
  })

  it('unused failed ref does not reject: runSettled fulfills, run() does not throw', async () => {
    const boom = new DominoCallError('reverted', { kind: 'revert', data: '0x' })
    const executor: StepExecutor = {
      async executeMulticall(calls): Promise<RawResult[]> {
        return calls.map((): RawResult => ({ status: 'failure', error: boom }))
      },
    }

    const makeTask = () =>
      defineTask((t) => {
        const a = t.call({ target: ADDR, abi: testAbi, functionName: 'getNum', args: [1n] })
        void a // deliberately unused — never appears in the returned shape
        return { ok: true as const }
      })

    const settled = await runSettled(executor, [makeTask()])
    expect(settled[0]!.status).toBe('fulfilled')
    expect((settled[0] as { status: 'fulfilled'; value: { ok: true } }).value).toEqual({ ok: true })

    const results = await runMultistepTasks(executor, [makeTask()])
    expect(results[0]).toEqual({ ok: true })
  })

  it('reachable failed ref rejects: run() throws the DominoCallError, runSettled rejects with the same error + diagnostics present', async () => {
    const boom = new DominoCallError('reverted', { kind: 'revert', data: '0x' })
    const executor: StepExecutor = {
      async executeMulticall(calls): Promise<RawResult[]> {
        return calls.map((): RawResult => ({ status: 'failure', error: boom }))
      },
    }

    const t1 = defineTask((t) => ({
      a: t.call({ target: ADDR, abi: testAbi, functionName: 'getNum', args: [1n] }),
    }))
    await expect(runMultistepTasks(executor, [t1])).rejects.toBe(boom)

    const t2 = defineTask((t) => ({
      a: t.call({ target: ADDR, abi: testAbi, functionName: 'getNum', args: [1n] }),
    }))
    const [settled] = await runSettled(executor, [t2])
    expect(settled!.status).toBe('rejected')
    expect((settled as { status: 'rejected'; error: unknown }).error).toBe(boom)
    expect(settled!.diagnostics).toEqual({ optionalFailures: [] })
  })

  it('a custom executor returning a failure carrying a raw (non-DominoCallError) error never discards it: the synthesized DominoCallError.cause is that exact object', async () => {
    const rawBoom = new Error('raw boom')
    const executor: StepExecutor = {
      async executeMulticall(calls): Promise<RawResult[]> {
        return calls.map((): RawResult => ({ status: 'failure', error: rawBoom }))
      },
    }

    const task = defineTask((t) => ({
      a: t.call({ target: ADDR, abi: testAbi, functionName: 'getNum', args: [1n] }),
    }))

    const [settled] = await runSettled(executor, [task])
    expect(settled!.status).toBe('rejected')
    const err = (settled as { status: 'rejected'; error: unknown }).error as DominoCallError
    expect(err).toBeInstanceOf(DominoCallError)
    expect(err.kind).toBe('batch')
    // The raw error must be preserved as `cause` — never discarded, never
    // conflated with the "no error at all" case (which omits `cause` entirely).
    expect(err.cause).toBe(rawBoom)
  })
})

describe('defineTask — optional escape hatch', () => {
  it('optional failure resolves to undefined; original DominoCallError retained in diagnostics.optionalFailures (fulfilled entry)', async () => {
    const boom = new DominoCallError('reverted', {
      kind: 'revert',
      data: '0x',
      target: ADDR,
      functionName: 'getStr',
    })
    const executor: StepExecutor = {
      async executeMulticall(calls): Promise<RawResult[]> {
        return calls.map((): RawResult => ({ status: 'failure', error: boom }))
      },
    }

    const task = defineTask((t) => {
      const a = t.call({ target: ADDR, abi: testAbi, functionName: 'getStr', optional: true })
      return { a }
    })

    const [result] = await runSettled(executor, [task])

    expect(result!.status).toBe('fulfilled')
    expect((result as { status: 'fulfilled'; value: { a: string | undefined } }).value).toEqual({
      a: undefined,
    })
    expect(result!.diagnostics.optionalFailures).toHaveLength(1)
    const entry = result!.diagnostics.optionalFailures[0]!
    expect(entry.error).toBe(boom)
    expect(entry.target).toBe(ADDR)
    expect(entry.functionName).toBe('getStr')
  })

  it('optional failure feeding a CALL: that call is skipped (cannot encode undefined), cause = the optional ref\'s original error', async () => {
    const boom = new DominoCallError('reverted', { kind: 'revert', data: '0x' })
    const executor: StepExecutor = {
      async executeMulticall(calls): Promise<RawResult[]> {
        return calls.map((c): RawResult => {
          const args = c.args as readonly unknown[] | undefined
          if (args?.[0] === 1n) return { status: 'failure', error: boom }
          return { status: 'success', value: 5n }
        })
      },
    }

    const task = defineTask((t) => {
      const a = t.call({
        target: ADDR,
        abi: testAbi,
        functionName: 'getNum',
        args: [1n],
        optional: true,
      })
      const b = t.call({ target: ADDR, abi: testAbi, functionName: 'getNum', args: [a] })
      return { b }
    })

    const [result] = await runSettled(executor, [task])

    expect(result!.status).toBe('rejected')
    const err = (result as { status: 'rejected'; error: unknown }).error as DominoCallError
    expect(err.kind).toBe('skipped')
    expect(err.cause).toBe(boom)
    // 'a' was optional -> its failure still lands in diagnostics even though 'b' (non-optional) rejects the task.
    expect(result!.diagnostics.optionalFailures).toHaveLength(1)
    expect(result!.diagnostics.optionalFailures[0]!.error).toBe(boom)
  })

  it('a call that is itself optional demotes to undefined + diagnostics even when skipped by an upstream optional failure', async () => {
    const boom = new DominoCallError('reverted', { kind: 'revert', data: '0x' })
    const executor: StepExecutor = {
      async executeMulticall(calls): Promise<RawResult[]> {
        return calls.map((c): RawResult => {
          const args = c.args as readonly unknown[] | undefined
          if (args?.[0] === 1n) return { status: 'failure', error: boom }
          return { status: 'success', value: 5n }
        })
      },
    }

    const task = defineTask((t) => {
      const a = t.call({
        target: ADDR,
        abi: testAbi,
        functionName: 'getNum',
        args: [1n],
        optional: true,
      })
      const b = t.call({
        target: ADDR,
        abi: testAbi,
        functionName: 'getNum',
        args: [a],
        optional: true,
      })
      return { b }
    })

    const [result] = await runSettled(executor, [task])

    expect(result!.status).toBe('fulfilled')
    expect((result as { status: 'fulfilled'; value: { b: bigint | undefined } }).value).toEqual({
      b: undefined,
    })
    // Both a's original revert AND b's derived skip failure land in diagnostics.
    expect(result!.diagnostics.optionalFailures).toHaveLength(2)
    expect(result!.diagnostics.optionalFailures[0]!.error).toBe(boom)
    const bEntry = result!.diagnostics.optionalFailures[1]!
    expect(bEntry.error).toBeInstanceOf(DominoCallError)
    expect((bEntry.error as DominoCallError).kind).toBe('skipped')
    expect((bEntry.error as DominoCallError).cause).toBe(boom)
  })
})

describe('defineTask — a `v`-undefined argument skip-chains a CALL (external review P1)', () => {
  // Closes a gap where a "successful"-but-malformed upstream value (most
  // commonly demoted to `undefined` by a handler's own coercion derive, e.g.
  // `src/handlers/erc4626.ts`'s `asBigInt`) could otherwise reach as far as
  // a dependent call's argument encoding — see `resolveAll`'s doc comment in
  // `src/core/defineTask.ts`.

  it('a derive that legitimately resolves to undefined, feeding a non-optional CALL arg, skip-chains that call (synthesized cause, no upstream failure at all)', async () => {
    let executeCount = 0
    const executor: StepExecutor = {
      async executeMulticall(calls): Promise<RawResult[]> {
        executeCount++
        // Every call "succeeds" — but with a value the coercion derive
        // below will reject (not a bigint).
        return calls.map((): RawResult => ({ status: 'success', value: 'not-a-number' }))
      },
    }

    const task = defineTask((t) => {
      const raw = t.call({ target: ADDR, abi: testAbi, functionName: 'getNum', args: [1n] })
      // Exactly the handler coercion-derive pattern: legitimately resolves
      // to `undefined` for a malformed (non-bigint) upstream value.
      const coerced = t.derive([raw], (v) => (typeof v === 'bigint' ? v : undefined))
      const dependent = t.call({ target: ADDR, abi: testAbi, functionName: 'getNum', args: [coerced] })
      return { dependent }
    })

    const [result] = await runSettled(executor, [task])

    expect(result!.status).toBe('rejected')
    const err = (result as { status: 'rejected'; error: unknown }).error as DominoCallError
    expect(err.kind).toBe('skipped')
    expect(err.cause).toBeInstanceOf(DominoCallError)
    const cause = err.cause as DominoCallError
    expect(cause.kind).toBe('skipped')
    expect(cause.message).toBe('argument resolved to undefined')
    // No real upstream failure exists to preserve — the synthesized cause
    // carries no cause of its own (nothing was thrown, nothing reverted).
    expect(cause.cause).toBeUndefined()

    // `dependent` (depth 2) was never dispatched — only `raw`'s single
    // executor invocation (step 1) happened.
    expect(executeCount).toBe(1)
  })

  it('optional chain: a derive-produced undefined feeding an OPTIONAL call demotes that call too, recorded in diagnostics with the synthesized cause (accepted-delta extension)', async () => {
    let executeCount = 0
    const executor: StepExecutor = {
      async executeMulticall(calls): Promise<RawResult[]> {
        executeCount++
        return calls.map((): RawResult => ({ status: 'success', value: 'not-a-number' }))
      },
    }

    const task = defineTask((t) => {
      const raw = t.call({ target: ADDR, abi: testAbi, functionName: 'getNum', args: [1n], optional: true })
      const coerced = t.derive([raw], (v) => (typeof v === 'bigint' ? v : undefined))
      const dependent = t.call({
        target: ADDR,
        abi: testAbi,
        functionName: 'getNum',
        args: [coerced],
        optional: true,
      })
      return { dependent }
    })

    const [result] = await runSettled(executor, [task])

    expect(result!.status).toBe('fulfilled')
    expect((result as { status: 'fulfilled'; value: { dependent: bigint | undefined } }).value).toEqual({
      dependent: undefined,
    })
    // `dependent` (depth 2) is skip-chained before ever reaching the
    // executor — only `raw`'s step-1 call is dispatched.
    expect(executeCount).toBe(1)

    // `raw`'s OWN call succeeded (the executor returned `status: 'success'`)
    // — only the coercion derive rejected its value, so `raw` itself never
    // enters diagnostics. `dependent`'s skip-chain does — the accepted-delta
    // extension: an optional call can now be demoted by a synthesized
    // "argument resolved to undefined" cause, not just a real upstream
    // DominoCallError.
    expect(result!.diagnostics.optionalFailures).toHaveLength(1)
    const entry = result!.diagnostics.optionalFailures[0]!
    expect(entry.error.kind).toBe('skipped')
    expect(entry.error.cause).toBeInstanceOf(DominoCallError)
    expect((entry.error.cause as DominoCallError).message).toBe('argument resolved to undefined')
  })

  it('derives themselves are unaffected: a derive consuming a v-undefined input still computes normally (no skip)', async () => {
    const executor: StepExecutor = {
      async executeMulticall(calls): Promise<RawResult[]> {
        return calls.map((): RawResult => ({ status: 'success', value: 'not-a-number' }))
      },
    }

    const task = defineTask((t) => {
      const raw = t.call({ target: ADDR, abi: testAbi, functionName: 'getNum', args: [1n] })
      const coerced = t.derive([raw], (v) => (typeof v === 'bigint' ? v : undefined))
      // A SECOND derive consuming the first derive's (legitimately
      // undefined) output — derives can always consume `undefined`.
      const fallback = t.derive([coerced], (v) => v ?? -1n)
      return { coerced, fallback }
    })

    const [result] = await runMultistepTasks(executor, [task])

    expect(result).toEqual({ coerced: undefined, fallback: -1n })
  })
})

describe('defineTask — internal dedupe-eligibility marker', () => {
  it('stamps every compiled StepCall with the internal marker; dedupe: false yields false', () => {
    const task = defineTask((t) => {
      const a = t.call({ target: ADDR, abi: testAbi, functionName: 'getStr' })
      const b = t.call({ target: ADDR, abi: testAbi, functionName: 'getStr', dedupe: false })
      return { a, b }
    })

    const calls = task.buildStepCalls(1)
    expect(calls).toHaveLength(2)

    const marker = (call: StepCall): symbol | undefined =>
      Object.getOwnPropertySymbols(call).find((s) => s.description === 'domino.dedupeEligible')

    const symA = marker(calls[0]!)
    const symB = marker(calls[1]!)
    expect(symA).toBeDefined()
    expect(symB).toBeDefined()
    expect((calls[0] as unknown as Record<symbol, unknown>)[symA!]).toBe(true)
    expect((calls[1] as unknown as Record<symbol, unknown>)[symB!]).toBe(false)
  })
})

describe('defineTask — mixed legacy + defineTask batching', () => {
  it('a legacy MultistepTask and a defineTask task in ONE runMultistepTasks call are batched together in the same executor invocation', async () => {
    let legacyCaptured: string | undefined
    const legacyTask: MultistepTask<{ v: string | undefined }> = {
      maxStep: 1,
      buildStepCalls(step) {
        if (step !== 1) return []
        return [{ key: 'legacy', target: ADDR, abi: [], functionName: 'legacyFn' }]
      },
      consumeStepResults(_step, results: StepResult[]) {
        const r = results.find((r) => r.key === 'legacy' && r.status === 'success')
        legacyCaptured = r?.status === 'success' ? (r.value as string) : undefined
      },
      finalize() {
        return { v: legacyCaptured }
      },
    }

    const newTask = defineTask((t) => ({
      a: t.call({ target: ADDR2, abi: testAbi, functionName: 'getStr' }),
    }))

    const batchSizes: number[] = []
    const executor: StepExecutor = {
      async executeMulticall(calls): Promise<RawResult[]> {
        batchSizes.push(calls.length)
        return calls.map((c): RawResult => {
          if (c.functionName === 'legacyFn') return { status: 'success', value: 'legacy-ok' }
          return { status: 'success', value: 'new-ok' }
        })
      },
    }

    // `runMultistepTasks<TResult>` shares one TResult across the whole array;
    // a genuinely mixed-shape batch is expressed by widening to `unknown`
    // (MultistepTask is covariant in TResult, so each task is still directly
    // assignable) — the FSM itself doesn't care about the shape at all.
    const tasks: MultistepTask<unknown>[] = [legacyTask, newTask]
    const [legacyResult, newResult] = await runMultistepTasks(executor, tasks)

    expect(batchSizes).toEqual([2])
    expect(legacyResult).toEqual({ v: 'legacy-ok' })
    expect(newResult).toEqual({ a: 'new-ok' })
  })
})

describe('defineTask — safety hardening (external review)', () => {
  it('a ref from one defineTask used as another defineTask\'s call arg throws synchronously at build time', () => {
    let foreignRef: unknown
    defineTask((t) => {
      foreignRef = t.call({ target: ADDR, abi: testAbi, functionName: 'getAddr' })
      return {}
    })

    expect(() =>
      defineTask((t) => {
        const b = t.call({
          target: ADDR,
          abi: testAbi,
          functionName: 'getNum',
          args: [foreignRef as any],
        })
        return { b }
      }),
    ).toThrow('Ref belongs to a different defineTask')
  })

  it('a ref from one defineTask used as another defineTask\'s derive input throws synchronously at build time', () => {
    let foreignRef: unknown
    defineTask((t) => {
      foreignRef = t.call({ target: ADDR, abi: testAbi, functionName: 'getAddr' })
      return {}
    })

    expect(() =>
      defineTask((t) => {
        const d = t.derive([foreignRef as any], (v) => v)
        return { d }
      }),
    ).toThrow('Ref belongs to a different defineTask')
  })

  it('a ref from one defineTask used as another defineTask\'s dynamic target throws synchronously at build time', () => {
    let foreignRef: unknown
    defineTask((t) => {
      foreignRef = t.call({ target: ADDR, abi: testAbi, functionName: 'getAddr' })
      return {}
    })

    expect(() =>
      defineTask((t) => {
        const b = t.call({
          target: foreignRef as any,
          abi: testAbi,
          functionName: 'getStr',
        })
        return { b }
      }),
    ).toThrow('Ref belongs to a different defineTask')
  })

  it('a retained builder `t` used after defineTask() has already returned throws (builder is closed)', () => {
    let capturedT: Parameters<Parameters<typeof defineTask>[0]>[0] | undefined
    defineTask((t) => {
      capturedT = t
      return {}
    })

    expect(capturedT).toBeDefined()
    expect(() =>
      capturedT!.call({ target: ADDR, abi: testAbi, functionName: 'getStr' }),
    ).toThrow('defineTask builder is closed')
  })

  it('an async build callback throws synchronously (a returned Promise is rejected as unsupported)', () => {
    expect(() => defineTask(async () => ({ a: 1 }))).toThrow(
      'defineTask builder callback must be synchronous',
    )
  })

  it('a Ref nested inside a class instance in the returned shape throws at finalize (deep exotic nesting unsupported)', async () => {
    class Box {
      constructor(public value: unknown) {}
    }

    const executor: StepExecutor = {
      async executeMulticall(calls): Promise<RawResult[]> {
        return calls.map((): RawResult => ({ status: 'success', value: 5n }))
      },
    }

    const task = defineTask((t) => {
      const a = t.call({ target: ADDR, abi: testAbi, functionName: 'getNum', args: [1n] })
      return { box: new Box(a) }
    })

    await expect(runMultistepTasks(executor, [task])).rejects.toThrow(
      'Refs inside class instances/non-plain objects are not supported',
    )
  })

  it('a Ref NOT nested inside any non-plain object still resolves fine (control case: plain objects/arrays unaffected)', async () => {
    const executor: StepExecutor = {
      async executeMulticall(calls): Promise<RawResult[]> {
        return calls.map((): RawResult => ({ status: 'success', value: 5n }))
      },
    }

    const task = defineTask((t) => {
      const a = t.call({ target: ADDR, abi: testAbi, functionName: 'getNum', args: [1n] })
      return { nested: { list: [a] } }
    })

    const [result] = await runMultistepTasks(executor, [task])
    expect(result).toEqual({ nested: { list: [5n] } })
  })
})

describe('defineTask — F3: human-readable ABI', () => {
  it('defines a task with human-readable ABI strings and executes identically to object form', async () => {
    // Human-readable form
    const stringAbi = [
      'function balanceOf(address) view returns (uint256)',
      'function symbol() view returns (string)',
    ] as const

    // Equivalent object form (for comparison)
    const objectAbi = [
      {
        type: 'function',
        name: 'balanceOf',
        stateMutability: 'view',
        inputs: [{ name: 'account', type: 'address' }],
        outputs: [{ type: 'uint256' }],
      },
      {
        type: 'function',
        name: 'symbol',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ type: 'string' }],
      },
    ] as const

    const executor: StepExecutor = {
      async executeMulticall(calls): Promise<RawResult[]> {
        return calls.map((c): RawResult => {
          if (c.functionName === 'balanceOf') {
            // Verify that the executor receives a parsed Abi object, not strings
            expect(typeof c.abi[0]).toBe('object')
            return { status: 'success', value: 100n }
          }
          return { status: 'success', value: 'TEST' }
        })
      },
    }

    // Task with human-readable ABI
    const taskString = defineTask((t) => {
      const bal = t.call({ target: ADDR, abi: stringAbi, functionName: 'balanceOf', args: [ADDR] })
      const sym = t.call({ target: ADDR, abi: stringAbi, functionName: 'symbol' })
      return { bal, sym }
    })

    // Task with object ABI
    const taskObject = defineTask((t) => {
      const bal = t.call({ target: ADDR, abi: objectAbi, functionName: 'balanceOf', args: [ADDR] })
      const sym = t.call({ target: ADDR, abi: objectAbi, functionName: 'symbol' })
      return { bal, sym }
    })

    // Both should execute with the same results
    const [resultString] = await runMultistepTasks(executor, [taskString])
    const [resultObject] = await runMultistepTasks(executor, [taskObject])

    expect(resultString).toEqual({ bal: 100n, sym: 'TEST' })
    expect(resultObject).toEqual({ bal: 100n, sym: 'TEST' })
    expect(resultString).toEqual(resultObject)
  })

  it('human-readable ABI with invalid fragment → parseAbiMemoized error propagates at BUILD time (defineTask throws synchronously)', () => {
    const invalidAbi = ['garbage not a valid abi fragment'] as const

    // Wrap in a function to avoid TypeScript errors on the invalid ABI
    function buildTask() {
      return defineTask((t) => {
        // This should throw synchronously during defineTask execution
        // because parseAbiMemoized is called in callImpl
        const bad = t.call({
          target: ADDR,
          abi: invalidAbi,
          functionName: 'someFunc',
          args: [],
        })
        return { bad }
      })
    }

    expect(buildTask).toThrow()
  })

  it('human-readable ABI: executor receives a parsed Abi (objects, not strings)', async () => {
    const stringAbi = ['function getVal() view returns (uint256)'] as const

    let receivedAbi: unknown

    const executor: StepExecutor = {
      async executeMulticall(calls): Promise<RawResult[]> {
        for (const call of calls) {
          if (call.functionName === 'getVal') {
            receivedAbi = call.abi
          }
        }
        return calls.map((): RawResult => ({ status: 'success', value: 42n }))
      },
    }

    const task = defineTask((t) => {
      const v = t.call({ target: ADDR, abi: stringAbi, functionName: 'getVal' })
      return { v }
    })

    await runMultistepTasks(executor, [task])

    // Verify the executor received an array of objects, not strings
    expect(Array.isArray(receivedAbi)).toBe(true)
    expect((receivedAbi as unknown[]).length).toBe(1)
    expect(typeof (receivedAbi as unknown[])[0]).toBe('object')
  })

  it('P1.2 fix: mixed array (parsed items + string items) → build-time throw', () => {
    // Create a mixed array with one parsed item and one string
    const mixed = [
      { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [] },
      'function bar() view returns (uint256)',
    ] as const

    function buildTaskMixed1() {
      return defineTask((t) => {
        const bad = t.call({
          target: ADDR,
          // @ts-expect-error mixing types to test validation
          abi: mixed,
          functionName: 'symbol',
          args: [],
        })
        return { bad }
      })
    }

    expect(buildTaskMixed1).toThrow('abi must be entirely human-readable strings or entirely parsed ABI items, not a mix')
  })

  it('P1.2 fix: mixed array reverse (string items + parsed items) → build-time throw', () => {
    // Create a mixed array with string first, then parsed item
    const mixed = [
      'function symbol() view returns (string)',
      { type: 'function', name: 'bar', stateMutability: 'view', inputs: [], outputs: [] },
    ] as const

    function buildTaskMixed2() {
      return defineTask((t) => {
        const bad = t.call({
          target: ADDR,
          // @ts-expect-error mixing types to test validation
          abi: mixed,
          functionName: 'symbol',
          args: [],
        })
        return { bad }
      })
    }

    expect(buildTaskMixed2).toThrow('abi must be entirely human-readable strings or entirely parsed ABI items, not a mix')
  })
})
