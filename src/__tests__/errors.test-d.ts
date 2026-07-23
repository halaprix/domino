import { describe, it, expectTypeOf } from 'vitest'
import { DominoCallError } from '../core/errors'
import type { DominoCallErrorKind } from '../core/errors'
import type { Address } from '../core/types'

/**
 * Type-level assertions for F4 (error taxonomy).
 *
 * `expectTypeOf(...).toEqualTypeOf(...)` is checked by `tsc` (via `npm run typecheck`,
 * which type-checks all of `src`), not at vitest runtime. This file's presence and
 * shape is what CI relies on to assert `lib` still includes `ES2022.Error` —
 * if it regressed, `new Error('x', { cause: 1 }).cause` would fail to type-check.
 */
describe('type-level: ES2022.Error + DominoCallError', () => {
  it('Error.cause is available and typed unknown (requires lib ES2022.Error)', () => {
    expectTypeOf(new Error('x', { cause: 1 }).cause).toEqualTypeOf<unknown>()
  })

  it('DominoCallErrorKind covers exactly the five taxonomy kinds', () => {
    expectTypeOf<DominoCallErrorKind>().toEqualTypeOf<
      'revert' | 'decode' | 'batch' | 'skipped' | 'derive'
    >()
  })

  it('DominoCallError field types match the spec', () => {
    const err = new DominoCallError('msg', { kind: 'revert' })
    expectTypeOf(err.kind).toEqualTypeOf<DominoCallErrorKind>()
    expectTypeOf(err.data).toEqualTypeOf<`0x${string}` | undefined>()
    expectTypeOf(err.target).toEqualTypeOf<Address | undefined>()
    expectTypeOf(err.functionName).toEqualTypeOf<string | undefined>()
    expectTypeOf(err.key).toEqualTypeOf<string | undefined>()
    expectTypeOf(err.cause).toEqualTypeOf<unknown>()
    expectTypeOf(err).toMatchTypeOf<Error>()
  })

  it('DominoCallError constructor accepts all documented opts', () => {
    expectTypeOf(DominoCallError).toBeConstructibleWith('msg', { kind: 'batch' })
    expectTypeOf(DominoCallError).toBeConstructibleWith('msg', {
      kind: 'decode',
      cause: new Error('boom'),
      data: '0x1234',
      target: '0x0000000000000000000000000000000000000000',
      functionName: 'totalSupply',
      key: 'k',
    })
  })
})
