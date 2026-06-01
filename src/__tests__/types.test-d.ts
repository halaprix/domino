/**
 * Type-level tests for the public API surface.
 *
 * These tests verify that the discriminated union types, generic inference,
 * and type constraints work correctly. They are compile-time checks only —
 * no runtime assertions beyond expectTypeOf.
 */

import { describe, it, expectTypeOf } from 'vitest'
import { runMultistepTasks } from '../core/runMultistepTasks'
import { buildErc20Task } from '../handlers/erc20'
import { buildErc4626Task } from '../handlers/erc4626'
import { MulticallResolver } from '../engines/resolver'
import type {
  StepResult,
  RawResult,
  MultistepTask,
  StepExecutor,
  Address,
} from '../core/types'
import type { Erc20TokenResolution } from '../handlers/erc20'
import type { Erc4626VaultResolution } from '../handlers/erc4626'

const ADDR = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address

// ---------------------------------------------------------------------------
// StepResult — discriminated union
// ---------------------------------------------------------------------------

describe('StepResult discriminated union', () => {
  it('success branch has a value field', () => {
    const r: StepResult = { status: 'success', key: 'x', value: 'foo' }
    if (r.status === 'success') {
      expectTypeOf(r.value).toBeUnknown()
    }
  })

  it('failure branch has no value field', () => {
    // @ts-expect-error — value is not allowed on the failure branch
    const _r: StepResult = { status: 'failure', key: 'x', value: 'bad' }
  })

  it('success branch has no error field', () => {
    // @ts-expect-error — error is not allowed on the success branch
    const _r: StepResult = { status: 'success', key: 'x', value: 'ok', error: new Error() }
  })
})

// ---------------------------------------------------------------------------
// RawResult — discriminated union
// ---------------------------------------------------------------------------

describe('RawResult discriminated union', () => {
  it('failure branch forbids a value field', () => {
    // @ts-expect-error — value is not allowed on failure
    const _r: RawResult = { status: 'failure', value: 'oops' }
  })

  it('success branch requires a value field', () => {
    // @ts-expect-error — value is required on success
    const _r: RawResult = { status: 'success' }
  })
})

// ---------------------------------------------------------------------------
// runMultistepTasks — TResult inference
// ---------------------------------------------------------------------------

describe('runMultistepTasks TResult inference', () => {
  it('infers TResult from ERC20 tasks', async () => {
    const mockExecutor: StepExecutor = {
      async executeMulticall(calls) {
        return calls.map(() => ({ status: 'success' as const, value: 'x' }))
      },
    }
    const tasks = [buildErc20Task({ token: ADDR })]
    const result = runMultistepTasks(mockExecutor, tasks)
    expectTypeOf(result).resolves.toEqualTypeOf<Erc20TokenResolution[]>()
  })

  it('infers TResult from ERC4626 tasks', async () => {
    const mockExecutor: StepExecutor = {
      async executeMulticall(calls) {
        return calls.map(() => ({ status: 'success' as const, value: 'x' }))
      },
    }
    const tasks = [buildErc4626Task({ vault: ADDR })]
    const result = runMultistepTasks(mockExecutor, tasks)
    expectTypeOf(result).resolves.toEqualTypeOf<Erc4626VaultResolution[]>()
  })
})

// ---------------------------------------------------------------------------
// MulticallResolver — constructor accepts StepExecutor
// ---------------------------------------------------------------------------

describe('MulticallResolver', () => {
  it('constructor accepts a StepExecutor', () => {
    const executor: StepExecutor = { async executeMulticall() { return [] } }
    const resolver = new MulticallResolver(executor)
    expectTypeOf(resolver.resolveErc20).toBeFunction()
    expectTypeOf(resolver.resolveErc4626).toBeFunction()
    expectTypeOf(resolver.resolveErc20Bulk).toBeFunction()
    expectTypeOf(resolver.resolveErc4626Bulk).toBeFunction()
  })

  it('resolveErc20 returns Erc20TokenResolution', () => {
    const executor: StepExecutor = {
      async executeMulticall(calls) {
        return calls.map(() => ({ status: 'success' as const, value: 'x' }))
      },
    }
    const resolver = new MulticallResolver(executor)
    expectTypeOf(resolver.resolveErc20({ token: ADDR })).resolves.toEqualTypeOf<Erc20TokenResolution>()
  })
})

// ---------------------------------------------------------------------------
// MultistepTask — generic variance
// ---------------------------------------------------------------------------

describe('MultistepTask generic', () => {
  it('MultistepTask<A> is assignable to MultistepTask<A|B> (covariant finalize)', () => {
    type A = { x: string }
    type B = { y: number }

    const taskA: MultistepTask<A> = {
      maxStep: 1,
      buildStepCalls: () => [],
      consumeStepResults: () => {},
      finalize: () => ({ x: 'hi' }),
    }

    // A is a subtype of A|B, so MultistepTask<A> should be assignable to MultistepTask<A|B>
    const _taskAorB: MultistepTask<A | B> = taskA
    expectTypeOf(_taskAorB.finalize()).toEqualTypeOf<A | B>()
  })
})
