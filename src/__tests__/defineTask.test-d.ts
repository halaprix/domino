import { describe, it, expectTypeOf } from 'vitest'
import { defineTask } from '../core/defineTask'
import type { TaskBuilder, TypedCallSpec } from '../core/defineTask'
import type { Ref, WithRefs, ResolveRefs } from '../core/refs'
import type { Address } from '../core/types'

/**
 * Type-level assertions for F1 (typed results) + F2 (`defineTask`).
 *
 * `expectTypeOf(...).toEqualTypeOf(...)` is checked by `tsc` (via `npm run typecheck`,
 * which type-checks all of `src`), not at vitest runtime — see errors.test-d.ts for
 * the same convention.
 */

const ADDR = '0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4' as Address

const abi = [
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
  {
    type: 'function',
    name: 'owner',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'getReserveData',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [
      { name: 'liquidityIndex', type: 'uint128' },
      { name: 'currentLiquidityRate', type: 'uint128' },
      { name: 'variableBorrowIndex', type: 'uint128' },
    ],
  },
] as const

describe('type-level: Ref/WithRefs/ResolveRefs', () => {
  it('ResolveRefs unwraps Ref<T> leaves recursively through plain objects/arrays/tuples; non-ref values pass through', () => {
    type Shape = { a: Ref<bigint>; b: { c: Ref<string>; d: 42 } }
    expectTypeOf<ResolveRefs<Shape>>().toEqualTypeOf<{ a: bigint; b: { c: string; d: 42 } }>()
  })

  it('ResolveRefs passes through an array of Refs as an array of resolved values', () => {
    type Shape = Ref<bigint>[]
    expectTypeOf<ResolveRefs<Shape>>().toEqualTypeOf<bigint[]>()
  })

  it('ResolveRefs preserves tuple arity/order', () => {
    type Shape = readonly [Ref<bigint>, Ref<string>]
    expectTypeOf<ResolveRefs<Shape>>().toEqualTypeOf<readonly [bigint, string]>()
  })

  it('WithRefs makes Ref<T> assignable at every arg position, preserving tuple arity', () => {
    type Args = readonly [Address, bigint]
    type Widened = WithRefs<Args>

    const literalOnly: Widened = [ADDR, 1n]
    const mixed: Widened = [ADDR, {} as Ref<bigint>]
    void literalOnly
    void mixed

    // @ts-expect-error -- wrong element type at position 1 (string not assignable to bigint | Ref<bigint>)
    const wrong: Widened = [ADDR, 'nope']
    void wrong
  })
})

describe('type-level: TaskBuilder.call return inference from ABI', () => {
  it('single-output view function infers Ref<primitive>', () => {
    defineTask((t: TaskBuilder) => {
      const bal = t.call({ target: ADDR, abi, functionName: 'balanceOf', args: [ADDR] })
      expectTypeOf(bal).toEqualTypeOf<Ref<bigint>>()

      const sym = t.call({ target: ADDR, abi, functionName: 'symbol' })
      expectTypeOf(sym).toEqualTypeOf<Ref<string>>()

      return { bal, sym }
    })
  })

  it('multi-output view function infers Ref<tuple>', () => {
    defineTask((t: TaskBuilder) => {
      const reserve = t.call({ target: ADDR, abi, functionName: 'getReserveData', args: [ADDR] })
      expectTypeOf(reserve).toEqualTypeOf<Ref<readonly [bigint, bigint, bigint]>>()
      return { reserve }
    })
  })

  it('functionName is limited to view|pure — a nonpayable name is a type error', () => {
    defineTask((t: TaskBuilder) => {
      // @ts-expect-error -- 'transfer' is nonpayable, not view|pure
      const bad = t.call({ target: ADDR, abi, functionName: 'transfer', args: [ADDR, 1n] })
      void bad
      return {}
    })
  })

  it('args positions accept both the literal value and a Ref of the same type', () => {
    defineTask((t: TaskBuilder) => {
      const ownerRef = t.call({ target: ADDR, abi, functionName: 'owner' })
      expectTypeOf(ownerRef).toEqualTypeOf<Ref<Address>>()

      // literal address
      const a = t.call({ target: ADDR, abi, functionName: 'balanceOf', args: [ADDR] })
      // genuine Ref<Address> (from `owner` above) at an arg position that expects Address
      const b = t.call({ target: ADDR, abi, functionName: 'balanceOf', args: [ownerRef] })
      return { a, b }
    })
  })

  it('wrong arg type is rejected', () => {
    defineTask((t: TaskBuilder) => {
      // @ts-expect-error -- balanceOf expects an Address, not a bigint
      const bad = t.call({ target: ADDR, abi, functionName: 'balanceOf', args: [1n] })
      void bad
      return {}
    })
  })

  it('optional: true widens the ref to Ref<T | undefined>', () => {
    defineTask((t: TaskBuilder) => {
      const maybe = t.call({
        target: ADDR,
        abi,
        functionName: 'balanceOf',
        args: [ADDR],
        optional: true,
      })
      expectTypeOf(maybe).toEqualTypeOf<Ref<bigint | undefined>>()

      const notOptional = t.call({ target: ADDR, abi, functionName: 'balanceOf', args: [ADDR] })
      expectTypeOf(notOptional).toEqualTypeOf<Ref<bigint>>()

      return { maybe, notOptional }
    })
  })

  it('target accepts Ref<Address> but not Ref<bigint>', () => {
    defineTask((t: TaskBuilder) => {
      const ownerRef = t.call({ target: ADDR, abi, functionName: 'owner' }) // Ref<Address>
      const bigintRef = t.call({ target: ADDR, abi, functionName: 'balanceOf', args: [ADDR] }) // Ref<bigint>

      const spec: TypedCallSpec<typeof abi, 'symbol'> = {
        target: ADDR,
        abi,
        functionName: 'symbol',
      }
      void spec

      // dynamic target from a genuine Ref<Address> — must compile.
      const dyn = t.call({ target: ownerRef, abi, functionName: 'symbol' })

      // @ts-expect-error -- Ref<bigint> is not assignable to Address | Ref<Address>
      const bad = t.call({ target: bigintRef, abi, functionName: 'symbol' })
      void bad

      return { dyn }
    })
  })
})
