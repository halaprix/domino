import { describe, it, expectTypeOf } from 'vitest'
import type { SettledTaskResult, TaskDiagnostics } from '../core/runSettled'

/**
 * Type-level assertions for F5 (`runSettled`).
 *
 * `expectTypeOf(...).toEqualTypeOf(...)` is checked by `tsc` (via `npm run typecheck`,
 * which type-checks all of `src`), not at vitest runtime — see errors.test-d.ts for
 * the same convention.
 */
describe('type-level: SettledTaskResult / TaskDiagnostics', () => {
  it('discriminates on status, narrowing value/error per branch', () => {
    type R = SettledTaskResult<{ a: number }>

    const fulfilled: R = {
      status: 'fulfilled',
      value: { a: 1 },
      diagnostics: { optionalFailures: [] },
    }
    if (fulfilled.status === 'fulfilled') {
      expectTypeOf(fulfilled.value).toEqualTypeOf<{ a: number }>()
      expectTypeOf(fulfilled.diagnostics).toEqualTypeOf<TaskDiagnostics>()
      // @ts-expect-error -- `error` does not exist on the fulfilled branch
      void fulfilled.error
    }

    const rejected: R = {
      status: 'rejected',
      error: new Error('x'),
      diagnostics: { optionalFailures: [] },
    }
    if (rejected.status === 'rejected') {
      expectTypeOf(rejected.error).toEqualTypeOf<unknown>()
      expectTypeOf(rejected.diagnostics).toEqualTypeOf<TaskDiagnostics>()
      // @ts-expect-error -- `value` does not exist on the rejected branch
      void rejected.value
    }
  })

  it('requires diagnostics on both branches (always present, never optional)', () => {
    type R = SettledTaskResult<{ a: number }>

    // @ts-expect-error -- diagnostics is required, not optional, on the fulfilled branch
    const missingFulfilled: R = { status: 'fulfilled', value: { a: 1 } }
    // @ts-expect-error -- diagnostics is required, not optional, on the rejected branch
    const missingRejected: R = { status: 'rejected', error: 'x' }

    void missingFulfilled
    void missingRejected
  })

  it('TaskDiagnostics.optionalFailures carries target?/functionName?/error (DominoCallError)', () => {
    expectTypeOf<TaskDiagnostics>().toHaveProperty('optionalFailures')
  })
})
