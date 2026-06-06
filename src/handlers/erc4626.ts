/**
 * ERC4626 handler : framework-agnostic task builder + convenience functions.
 *
 * Builds a MultistepTask that resolves ERC4626 vault metadata (symbol, decimals,
 * underlying asset, maxWithdraw, maxRedeem) and optionally position (balance, assets).
 *
 * Without owner:     Step 1 only  (symbol, decimals, asset)
 * With owner:        Step 1 + Step 2 (symbol, decimals, asset, balanceOf, maxWithdraw,
 *                    maxRedeem → then convertToAssets(balance))
 */

import type { Address, MultistepTask, StepCall, StepResult, StepExecutor, BlockParam } from '../core/types'
import { runMultistepTasks } from '../core/runMultistepTasks'

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
    maxWithdraw: bigint | undefined
    maxRedeem: bigint | undefined
  }
  position: { balance: bigint; assets: bigint | undefined } | undefined
}

type Erc4626Context = {
  symbol?: string
  decimals?: number
  balance?: bigint
  maxWithdraw?: bigint
  maxRedeem?: bigint
  underlyingAsset?: Address
  assets?: bigint
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

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

// ─── Domain layer ─────────────────────────────────────────────────────────────
// buildErc4626Task — pure MultistepTask factory; no orchestration dependency.
// Safe to use in custom pipelines, test doubles, and non-engine contexts.

export function buildErc4626Task(params: {
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
            ? { balance: ctx.balance, assets: ctx.assets }
            : undefined,
      }
    },
  }
}

// ─── Application layer ────────────────────────────────────────────────────────
// Convenience resolvers that compose buildErc4626Task with runMultistepTasks.
// Use from engine entry points or when a StepExecutor is already available.

export async function resolveErc4626Vault(params: {
  client: StepExecutor
  vault: Address
  owner?: Address
  block?: BlockParam
}): Promise<Erc4626VaultResolution> {
  const executor = params.client
  const taskParams: { vault: Address; owner?: Address } = { vault: params.vault }
  if (params.owner !== undefined) taskParams.owner = params.owner
  const [result] = await runMultistepTasks(executor, [buildErc4626Task(taskParams)], {
    ...(params.block !== undefined ? { block: params.block } : {}),
  })
  return result!
}

export async function resolveErc4626VaultsBulk(params: {
  client: StepExecutor
  entries: { vault: Address; owner?: Address }[]
  batchSize?: number
  block?: BlockParam
}): Promise<Erc4626VaultResolution[]> {
  if (params.entries.length === 0) return []
  const executor = params.client
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
