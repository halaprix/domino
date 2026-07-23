/**
 * G1 parity-test oracle — pre-migration `buildErc20Task` (verbatim
 * task-construction closure, inlined ABI, and `KEYS`, moved unmodified from
 * `src/handlers/erc20.ts` as of the last pre-G1 commit).
 *
 * **Purpose:** `src/__tests__/parity-g1.test.ts` runs the SAME scenario
 * table through this legacy implementation and the new `defineTask`-based
 * `buildErc20Task` (`src/handlers/erc20.ts`), asserting
 * `expect(newResult).toStrictEqual(legacyResult)`. This file is the ORACLE
 * side of that comparison — never the thing under test.
 *
 * **Lifecycle:** test-only import, never imported from `src/index.ts` or any
 * runtime module — excluded from the public runtime path and the bundle
 * (see `src/__tests__/bundle-size.test.ts`, which asserts the bundle does
 * not grow materially, and the migration report's `grep dist` sanity check
 * for the `KEYS`-specific string below). Retained for exactly one minor
 * release after G1 ships (1.3.x), then deleted; the rollback path if G1 ever
 * needs to be reverted is a patch release built from git history (this file
 * pre-dates the deletion commit), not a runtime feature flag.
 *
 * Keeps the `SINGLE_USE` brand (imported from `core/internal`, same as the
 * production handlers) so parity fixtures exercise the identical
 * single-run/reuse-guard behavior on both sides of the comparison.
 */

import type { Address, MultistepTask, StepCall, StepResult } from '../../../core/types'
import { SINGLE_USE } from '../../../core/internal'
import type { SingleUseCarrier } from '../../../core/internal'
import type { Erc20TokenResolution } from '../../../handlers/erc20'

/** Minimal ERC20 ABI — only the functions used by buildErc20TaskLegacy. */
const erc20Abi = [
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const

type Erc20Context = {
  symbol?: string
  decimals?: number
  balance?: bigint
}

// Typed accessor helpers — safe coercion from the untyped RawResult.value.
// These replace `as T` casts; returning undefined instead of producing wrong
// data when an executor returns an unexpected value type.
const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const asBigInt = (v: unknown): bigint | undefined => (typeof v === 'bigint' ? v : undefined)
const asNumber = (v: unknown): number | undefined => {
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

// Routing key constants — typos in key strings would cause silent routing misses;
// using a const object makes them a compile error instead.
const KEYS = {
  symbol: 'symbol',
  decimals: 'decimals',
  balance: 'balance',
} as const

export function buildErc20TaskLegacy(params: {
  token: Address
  owner?: Address
}): MultistepTask<Erc20TokenResolution> {
  const { token, owner } = params
  const ctx: Erc20Context = {}

  return {
    maxStep: 1,

    buildStepCalls(step) {
      if (step !== 1) return []

      const calls: StepCall[] = [
        { key: KEYS.symbol, target: token, abi: erc20Abi, functionName: 'symbol' },
        { key: KEYS.decimals, target: token, abi: erc20Abi, functionName: 'decimals' },
      ]

      if (owner) {
        calls.push({
          key: KEYS.balance,
          target: token,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [owner],
        })
      }

      return calls
    },

    consumeStepResults(_step, results: StepResult[]) {
      for (const result of results) {
        if (result.status === 'failure') continue
        // TypeScript narrows result to the success branch here.
        // exactOptionalPropertyTypes: only assign when the value is defined.
        const sym = result.key === KEYS.symbol ? asString(result.value) : undefined
        if (sym !== undefined) ctx.symbol = sym
        const dec = result.key === KEYS.decimals ? asNumber(result.value) : undefined
        if (dec !== undefined) ctx.decimals = dec
        const bal = result.key === KEYS.balance ? asBigInt(result.value) : undefined
        if (bal !== undefined) ctx.balance = bal
      }
    },

    finalize() {
      return {
        symbol: ctx.symbol,
        decimals: ctx.decimals,
        balance: ctx.balance,
      }
    },

    [SINGLE_USE]: true,
  } as MultistepTask<Erc20TokenResolution> & SingleUseCarrier
}
