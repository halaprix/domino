/**
 * ERC4626 handler : framework-agnostic task builder + convenience functions.
 *
 * Builds a MultistepTask that resolves ERC4626 vault metadata (symbol, decimals,
 * underlying asset, maxWithdraw, maxRedeem) and optionally position (balance, assets).
 *
 * Without owner:     Step 1 only  (symbol, decimals, asset)
 * With owner:        Step 1 + Step 2 (symbol, decimals, asset, balanceOf, maxWithdraw,
 *                    maxRedeem → then convertToAssets(balance))
 *
 * (G1) Internally reimplemented on `defineTask` — public `buildErc4626Task`/
 * `resolveErc4626*` signatures and return shapes are unchanged from 1.0. Every
 * contract call is `optional: true`, replicating 1.0's silent-undefined-
 * per-field semantics. `convertToAssets` takes the RAW `balanceOf` call ref
 * (not the coerced value) as its `args` — this is what replicates the old
 * step-2 gating exactly: a failed/malformed balance demotes that ref to
 * `undefined`, which a call can never encode, so `convertToAssets` is
 * skip-chained (never dispatched) instead of being called with a bogus
 * argument — matching 1.0's `if (ctx.balance === undefined) return []`.
 * `position`'s conditional-key shape (T11) is reproduced with `t.derive`:
 * `undefined` when balance never resolved, else an object with `maxWithdraw`/
 * `maxRedeem` keys present ONLY when those calls resolved (never
 * present-with-`undefined`) — see `src/__tests__/parity-g1.test.ts`, which
 * `toStrictEqual`s this against the pre-migration oracle at
 * `src/__tests__/fixtures/legacy-handlers/erc4626.ts` (deleted after one
 * minor — see its header comment).
 *
 * **Accepted behavioral delta (documented, not parity-breaking — see the
 * parity test):** under `runSettled`, each `optional` call's
 * `DominoCallError` is now retained in `diagnostics.optionalFailures` instead
 * of being silently destroyed (the legacy implementation carried no
 * diagnostics channel at all). Resolved VALUES are byte-for-byte unchanged
 * either way. New calls are also dedup-ELIGIBLE (`TypedCallSpec`-compiled) —
 * `{ dedupe: true }` can now merge identical calls across bulk entries
 * (e.g. two vaults sharing the same owner never merge, since `target`
 * differs, but the metadata calls of two entries pointed at the SAME vault
 * would); legacy hand-authored `StepCall`s were never eligible.
 */

import type { Address, MultistepTask, BlockParam } from '../core/types'
import { defineTask } from '../core/defineTask'
import { runMultistepTasks } from '../core/runMultistepTasks'
import type { ExecutorParam } from './executorParam'
import { resolveExecutor } from './executorParam'

/** Minimal ERC20 ABI — only the functions used by buildErc4626Task. */
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

/** Minimal ERC4626 ABI — only the functions used by buildErc4626Task. */
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

// ─── Value types ──────────────────────────────────────────────────────────────

export interface Erc4626VaultResolution {
  metadata: {
    symbol: string | undefined
    decimals: number | undefined
    underlyingAsset: Address | undefined
    /** @deprecated Use `position.maxWithdraw` instead (F11 — same value) */
    maxWithdraw: bigint | undefined
    /** @deprecated Use `position.maxRedeem` instead (F11 — same value) */
    maxRedeem: bigint | undefined
  }
  position:
    | {
        balance: bigint
        assets: bigint | undefined
        /** Optional, populated when maxWithdraw call succeeds (F11) */
        maxWithdraw?: bigint
        /** Optional, populated when maxRedeem call succeeds (F11) */
        maxRedeem?: bigint
      }
    | undefined
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

// Typed accessor helpers — safe coercion from the untyped call result.
// Unchanged from the pre-defineTask implementation (see the legacy oracle) —
// reused here via `t.derive` so 1.0's defensive coercion behavior survives
// the migration byte-for-byte (this is what the compat suite pins).
const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const asBigInt = (v: unknown): bigint | undefined => (typeof v === 'bigint' ? v : undefined)
const asNumber = (v: unknown): number | undefined => {
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}
const asAddress = (v: unknown): Address | undefined =>
  typeof v === 'string' && v.startsWith('0x') ? (v as Address) : undefined

// ─── Domain layer ─────────────────────────────────────────────────────────────
// buildErc4626Task — pure MultistepTask factory; no orchestration dependency.
// Safe to use in custom pipelines, test doubles, and non-engine contexts.

export function buildErc4626Task(params: {
  vault: Address
  owner?: Address
}): MultistepTask<Erc4626VaultResolution> {
  const { vault, owner } = params

  return defineTask((t) => {
    // Creation order matters (parity with 1.0's step-1 call order, and with
    // positional mock-executor fixtures): symbol, decimals, asset.
    const symbolCall = t.call({ target: vault, abi: erc20Abi, functionName: 'symbol', optional: true })
    const decimalsCall = t.call({ target: vault, abi: erc20Abi, functionName: 'decimals', optional: true })
    const assetCall = t.call({ target: vault, abi: erc4626Abi, functionName: 'asset', optional: true })

    const symbol = t.derive([symbolCall], asString)
    const decimals = t.derive([decimalsCall], asNumber)
    const underlyingAsset = t.derive([assetCall], asAddress)

    if (!owner) {
      return {
        metadata: {
          symbol,
          decimals,
          underlyingAsset,
          maxWithdraw: undefined,
          maxRedeem: undefined,
        },
        position: undefined,
      }
    }

    // Continuing step-1 creation order: balanceOf, maxWithdraw, maxRedeem.
    const balanceCall = t.call({
      target: vault,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [owner],
      optional: true,
    })
    const maxWithdrawCall = t.call({
      target: vault,
      abi: erc4626Abi,
      functionName: 'maxWithdraw',
      args: [owner],
      optional: true,
    })
    const maxRedeemCall = t.call({
      target: vault,
      abi: erc4626Abi,
      functionName: 'maxRedeem',
      args: [owner],
      optional: true,
    })

    const maxWithdraw = t.derive([maxWithdrawCall], asBigInt)
    const maxRedeem = t.derive([maxRedeemCall], asBigInt)

    // Depth 2 (step 2): args take the RAW balanceCall ref (not the coerced
    // `balance` derive below) — see the module doc comment for why this is
    // what replicates 1.0's step-2 gating exactly (skip-chained, never
    // dispatched, when balance failed or came back malformed).
    const assetsCall = t.call({
      target: vault,
      abi: erc4626Abi,
      functionName: 'convertToAssets',
      args: [balanceCall],
      optional: true,
    })

    const balance = t.derive([balanceCall], asBigInt)
    const assets = t.derive([assetsCall], asBigInt)

    const position = t.derive(
      [balance, assets, maxWithdraw, maxRedeem],
      (balanceV, assetsV, maxWithdrawV, maxRedeemV) => {
        if (balanceV === undefined) return undefined
        return {
          balance: balanceV,
          assets: assetsV,
          // exactOptionalPropertyTypes: conditional spread only when defined
          ...(maxWithdrawV !== undefined ? { maxWithdraw: maxWithdrawV } : {}),
          ...(maxRedeemV !== undefined ? { maxRedeem: maxRedeemV } : {}),
        }
      },
    )

    return {
      metadata: {
        symbol,
        decimals,
        underlyingAsset,
        maxWithdraw,
        maxRedeem,
      },
      position,
    }
  })
}

// ─── Application layer ────────────────────────────────────────────────────────
// Convenience resolvers that compose buildErc4626Task with runMultistepTasks.
// Use from engine entry points or when a StepExecutor is already available.

export async function resolveErc4626Vault(
  params: ExecutorParam & {
    vault: Address
    owner?: Address
    block?: BlockParam
  },
): Promise<Erc4626VaultResolution> {
  const executor = resolveExecutor(params)
  const taskParams: { vault: Address; owner?: Address } = { vault: params.vault }
  if (params.owner !== undefined) taskParams.owner = params.owner
  const [result] = await runMultistepTasks(executor, [buildErc4626Task(taskParams)], {
    ...(params.block !== undefined ? { block: params.block } : {}),
  })
  return result!
}

/**
 * Canonical name for bulk ERC4626 vault resolution (F11).
 * Accepts both `executor:` (preferred) and `client:` (deprecated, F10) parameters.
 */
export async function resolveErc4626Bulk(
  params: ExecutorParam & {
    entries: { vault: Address; owner?: Address }[]
    batchSize?: number
    block?: BlockParam
  },
): Promise<Erc4626VaultResolution[]> {
  const executor = resolveExecutor(params)
  if (params.entries.length === 0) return []
  const tasks = params.entries.map((e) => {
    return e.owner !== undefined
      ? buildErc4626Task({ vault: e.vault, owner: e.owner as Address })
      : buildErc4626Task({ vault: e.vault })
  })
  return runMultistepTasks(
    executor,
    tasks,
    { ...(params.batchSize !== undefined ? { batchSize: params.batchSize } : {}), ...(params.block !== undefined ? { block: params.block } : {}) },
  )
}

/**
 * @deprecated Use `resolveErc4626Bulk` instead. Forever-in-1.x alias (F11).
 */
export const resolveErc4626VaultsBulk = resolveErc4626Bulk
