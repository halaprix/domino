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

describe('type-level: safety-hardening findings (external review)', () => {
  it('args is required once the function has at least one input; still omittable for zero-arg functions', () => {
    defineTask((t: TaskBuilder) => {
      // @ts-expect-error -- balanceOf takes an address; args cannot be omitted
      const bad = t.call({ target: ADDR, abi, functionName: 'balanceOf' })
      void bad

      // zero-arg function: args stays omittable.
      const sym = t.call({ target: ADDR, abi, functionName: 'symbol' })
      expectTypeOf(sym).toEqualTypeOf<Ref<string>>()

      return { sym }
    })
  })

  it('a widened `boolean` optional flag matches neither overload (must be narrowed to a literal true/false)', () => {
    defineTask((t: TaskBuilder) => {
      // `as boolean` (not `const o: boolean = true`) is deliberate: TS's control-flow
      // analysis narrows a never-reassigned `const` back to the literal `true` at each
      // read regardless of its declared annotation, which would defeat this test.
      const o = true as boolean
      // @ts-expect-error -- `optional: boolean` (genuinely widened, not a literal) matches
      // neither the `optional: true` nor the `optional?: false` overload
      const bad = t.call({ target: ADDR, abi, functionName: 'balanceOf', args: [ADDR], optional: o })
      void bad
      return {}
    })
  })

  it('target accepts an optional call\'s Ref<Address | undefined>, not just Ref<Address>', () => {
    defineTask((t: TaskBuilder) => {
      const maybeOwner = t.call({ target: ADDR, abi, functionName: 'owner', optional: true })
      expectTypeOf(maybeOwner).toEqualTypeOf<Ref<Address | undefined>>()

      // dynamic target from an OPTIONAL ref (Ref<Address | undefined>) — must compile;
      // the runtime skip-chain rule handles an actual undefined resolution.
      const dyn = t.call({ target: maybeOwner, abi, functionName: 'symbol' })
      return { dyn }
    })
  })
})

describe('type-level: F3 — human-readable ABI inference parity', () => {
  it('string form infers the same Ref<...> as object form (balanceOf example)', () => {
    // Object form (baseline)
    defineTask((t: TaskBuilder) => {
      const bal = t.call({ target: ADDR, abi, functionName: 'balanceOf', args: [ADDR] })
      expectTypeOf(bal).toEqualTypeOf<Ref<bigint>>()
      return { bal }
    })

    // String form (must infer identically)
    const stringAbi = [
      'function balanceOf(address account) view returns (uint256)',
      'function symbol() view returns (string)',
    ] as const

    defineTask((t: TaskBuilder) => {
      const bal = t.call({ target: ADDR, abi: stringAbi, functionName: 'balanceOf', args: [ADDR] })
      expectTypeOf(bal).toEqualTypeOf<Ref<bigint>>()
      return { bal }
    })
  })

  it('string form view/pure constraint: nonpayable function rejected via @ts-expect-error', () => {
    const stringAbi = [
      'function transfer(address to, uint256 amount) returns (bool)',
      'function balanceOf(address account) view returns (uint256)',
    ] as const

    defineTask((t: TaskBuilder) => {
      // @ts-expect-error -- 'transfer' is nonpayable, not view|pure, even in string form
      const bad = t.call({
        target: ADDR,
        abi: stringAbi,
        functionName: 'transfer',
        args: [ADDR, 1n],
      })
      void bad

      // balanceOf is view — this should compile
      const bal = t.call({ target: ADDR, abi: stringAbi, functionName: 'balanceOf', args: [ADDR] })
      expectTypeOf(bal).toEqualTypeOf<Ref<bigint>>()

      return { bal }
    })
  })

  it('string form arg tuple: wrong arg type rejected', () => {
    const stringAbi = [
      'function balanceOf(address account) view returns (uint256)',
      'function getNum(uint256 x) view returns (uint256)',
    ] as const

    defineTask((t: TaskBuilder) => {
      // @ts-expect-error -- balanceOf expects an address, not a bigint (even in string form)
      const bad = t.call({ target: ADDR, abi: stringAbi, functionName: 'balanceOf', args: [1n] })
      void bad

      // Correct args for getNum
      const num = t.call({ target: ADDR, abi: stringAbi, functionName: 'getNum', args: [1n] })
      expectTypeOf(num).toEqualTypeOf<Ref<bigint>>()

      return { num }
    })
  })

  it('string form zero-arg function: args still omittable', () => {
    const stringAbi = ['function symbol() view returns (string)'] as const

    defineTask((t: TaskBuilder) => {
      // args is omittable for zero-arg functions in string form too
      const sym = t.call({ target: ADDR, abi: stringAbi, functionName: 'symbol' })
      expectTypeOf(sym).toEqualTypeOf<Ref<string>>()
      return { sym }
    })
  })

  it('string form multi-output function: infers tuple correctly', () => {
    const stringAbi = [
      'function getReserveData(address asset) view returns (uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex)',
    ] as const

    defineTask((t: TaskBuilder) => {
      const data = t.call({
        target: ADDR,
        abi: stringAbi,
        functionName: 'getReserveData',
        args: [ADDR],
      })
      expectTypeOf(data).toEqualTypeOf<Ref<readonly [bigint, bigint, bigint]>>()
      return { data }
    })
  })
})
