/**
 * G1 parity-test oracle — pre-migration `buildErc4626Task` (verbatim
 * task-construction closure, inlined ABIs, and `KEYS`, moved unmodified from
 * `src/handlers/erc4626.ts` as of the last pre-G1 commit).
 *
 * **Purpose:** `src/__tests__/parity-g1.test.ts` runs the SAME scenario
 * table through this legacy implementation and the new `defineTask`-based
 * `buildErc4626Task` (`src/handlers/erc4626.ts`), asserting
 * `expect(newResult).toStrictEqual(legacyResult)`. This file is the ORACLE
 * side of that comparison — never the thing under test. In particular, this
 * is the `finalize()` whose conditional-spread `position` shape (T11) the
 * new `t.derive`-based implementation must reproduce exactly (absent keys,
 * not present-with-`undefined`).
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
import type { Erc4626VaultResolution } from '../../../handlers/erc4626'

/** Minimal ERC20 ABI — only the functions used by buildErc4626TaskLegacy. */
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

/** Minimal ERC4626 ABI — only the functions used by buildErc4626TaskLegacy. */
const erc4626Abi = [
  {
    type: 'function',
    name: 'asset',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'maxWithdraw',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'maxRedeem',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'convertToAssets',
    stateMutability: 'view',
    inputs: [{ name: 'shares', type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
  },
] as const

type Erc4626Context = {
  symbol?: string
  decimals?: number
  balance?: bigint
  maxWithdraw?: bigint
  maxRedeem?: bigint
  underlyingAsset?: Address
  assets?: bigint
}

// Typed accessor helpers — safe coercion from the untyped RawResult.value.
const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const asBigInt = (v: unknown): bigint | undefined => (typeof v === 'bigint' ? v : undefined)
const asNumber = (v: unknown): number | undefined => {
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}
const asAddress = (v: unknown): Address | undefined =>
  typeof v === 'string' && v.startsWith('0x') ? (v as Address) : undefined

// Routing key constants — compile-time protection against typos in key strings.
const KEYS = {
  symbol: 'symbol',
  decimals: 'decimals',
  asset: 'asset',
  balance: 'balance',
  maxWithdraw: 'maxWithdraw',
  maxRedeem: 'maxRedeem',
  assets: 'assets',
} as const

export function buildErc4626TaskLegacy(params: {
  vault: Address
  owner?: Address
}): MultistepTask<Erc4626VaultResolution> {
  const { vault, owner } = params
  const ctx: Erc4626Context = {}
  const hasOwner = !!owner

  return {
    maxStep: hasOwner ? 2 : 1,

    buildStepCalls(step) {
      if (step === 1) {
        const calls: StepCall[] = [
          { key: KEYS.symbol, target: vault, abi: erc20Abi, functionName: 'symbol' },
          { key: KEYS.decimals, target: vault, abi: erc20Abi, functionName: 'decimals' },
          { key: KEYS.asset, target: vault, abi: erc4626Abi, functionName: 'asset' },
        ]
        if (owner) {
          calls.push(
            {
              key: KEYS.balance,
              target: vault,
              abi: erc20Abi,
              functionName: 'balanceOf',
              args: [owner],
            },
            {
              key: KEYS.maxWithdraw,
              target: vault,
              abi: erc4626Abi,
              functionName: 'maxWithdraw',
              args: [owner],
            },
            {
              key: KEYS.maxRedeem,
              target: vault,
              abi: erc4626Abi,
              functionName: 'maxRedeem',
              args: [owner],
            },
          )
        }
        return calls
      }

      if (step === 2 && hasOwner) {
        if (ctx.balance === undefined) return []
        return [
          {
            key: KEYS.assets,
            target: vault,
            abi: erc4626Abi,
            functionName: 'convertToAssets',
            args: [ctx.balance],
          },
        ]
      }

      return []
    },

    consumeStepResults(step, results: StepResult[]) {
      for (const result of results) {
        if (result.status === 'failure') continue
        // TypeScript narrows result to the success branch here.
        // exactOptionalPropertyTypes: only assign when the value is defined.
        if (step === 1) {
          const sym = result.key === KEYS.symbol ? asString(result.value) : undefined
          if (sym !== undefined) ctx.symbol = sym
          const dec = result.key === KEYS.decimals ? asNumber(result.value) : undefined
          if (dec !== undefined) ctx.decimals = dec
          const asset = result.key === KEYS.asset ? asAddress(result.value) : undefined
          if (asset !== undefined) ctx.underlyingAsset = asset
          if (hasOwner) {
            const bal = result.key === KEYS.balance ? asBigInt(result.value) : undefined
            if (bal !== undefined) ctx.balance = bal
            const mw = result.key === KEYS.maxWithdraw ? asBigInt(result.value) : undefined
            if (mw !== undefined) ctx.maxWithdraw = mw
            const mr = result.key === KEYS.maxRedeem ? asBigInt(result.value) : undefined
            if (mr !== undefined) ctx.maxRedeem = mr
          }
        }
        if (step === 2 && result.key === KEYS.assets) {
          const assets = asBigInt(result.value)
          if (assets !== undefined) ctx.assets = assets
        }
      }
    },

    finalize(): Erc4626VaultResolution {
      return {
        metadata: {
          symbol: ctx.symbol,
          decimals: ctx.decimals,
          underlyingAsset: ctx.underlyingAsset,
          maxWithdraw: ctx.maxWithdraw,
          maxRedeem: ctx.maxRedeem,
        },
        position:
          hasOwner && ctx.balance !== undefined
            ? {
                balance: ctx.balance,
                assets: ctx.assets,
                // exactOptionalPropertyTypes: conditional spread only when defined
                ...(ctx.maxWithdraw !== undefined ? { maxWithdraw: ctx.maxWithdraw } : {}),
                ...(ctx.maxRedeem !== undefined ? { maxRedeem: ctx.maxRedeem } : {}),
              }
            : undefined,
      }
    },

    [SINGLE_USE]: true,
  } as MultistepTask<Erc4626VaultResolution> & SingleUseCarrier
}
