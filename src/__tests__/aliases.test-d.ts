import { describe, it, expectTypeOf } from 'vitest'
import { resolveErc20Token, type Erc20TokenResolution } from '../index'
import type { Address, StepExecutor } from '../core/types'

/**
 * Type-level assertions for F10 (ExecutorParam exclusive union).
 *
 * `@ts-expect-error` markers are checked by `tsc` (via `npm run typecheck`),
 * not at vitest runtime. Removing a marker will cause typecheck to fail.
 */

// Real typed StepExecutor (not 'any')
const mockExecutor: StepExecutor = {
  executeMulticall: async () => [],
}

const token = '0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4' as Address

describe('F10: ExecutorParam exclusive union (type-level)', () => {
  // Type-level tests only — no runtime execution
  it.skip('accepts executor: form only', () => {
    expectTypeOf(
      resolveErc20Token({
        executor: mockExecutor,
        token,
      }),
    ).toMatchTypeOf<Promise<Erc20TokenResolution>>()
  })

  it.skip('accepts client: form only (deprecated)', () => {
    expectTypeOf(
      resolveErc20Token({
        client: mockExecutor,
        token,
      }),
    ).toMatchTypeOf<Promise<Erc20TokenResolution>>()
  })

  it.skip('rejects both executor and client present', () => {
    expectTypeOf(
      // @ts-expect-error — ExecutorParam union rejects both branches
      resolveErc20Token({
        executor: mockExecutor,
        client: mockExecutor,
        token,
      }),
    ).toMatchTypeOf<Promise<Erc20TokenResolution>>()
  })

  it.skip('rejects neither executor nor client present', () => {
    expectTypeOf(
      // @ts-expect-error — ExecutorParam union requires at least one branch
      resolveErc20Token({
        token,
      }),
    ).toMatchTypeOf<Promise<Erc20TokenResolution>>()
  })
})
