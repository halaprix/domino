/**
 * ERC4626 handler — framework-agnostic task builder + convenience functions.
 *
 * Builds a MultistepTask that resolves ERC4626 vault metadata (symbol, decimals,
 * underlying asset, maxWithdraw, maxRedeem) and optionally position (balance, assets).
 *
 * Without owner:     Step 1 only  (symbol, decimals, asset)
 * With owner:        Step 1 + Step 2 (symbol, decimals, asset, balanceOf, maxWithdraw,
 *                    maxRedeem → then convertToAssets(balance))
 */

import type { Address, MultistepTask, StepCall, StepResult, StepExecutor } from '../core/types'
import { runMultistepTasks } from '../core/runMultistepTasks'
import { erc20Abi, erc4626Abi } from '../abis/erc'

export interface Erc4626VaultResolution {
  metadata: {
    symbol: string | undefined
    decimals: number | undefined
    underlyingAsset: Address | undefined
    maxWithdraw: bigint | undefined
    maxRedeem: bigint | undefined
  }
  position: { balance: bigint; assets: bigint } | undefined
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
          { key: 'symbol', target: vault, abi: erc20Abi, functionName: 'symbol' },
          { key: 'decimals', target: vault, abi: erc20Abi, functionName: 'decimals' },
          { key: 'asset', target: vault, abi: erc4626Abi, functionName: 'asset' },
        ]
        if (hasOwner && owner) {
          calls.push(
            {
              key: 'balance',
              target: vault,
              abi: erc20Abi,
              functionName: 'balanceOf',
              args: [owner],
            },
            {
              key: 'maxWithdraw',
              target: vault,
              abi: erc4626Abi,
              functionName: 'maxWithdraw',
              args: [owner],
            },
            {
              key: 'maxRedeem',
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
            key: 'assets',
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
        if (step === 1) {
          if (result.key === 'symbol') ctx.symbol = result.value as string
          if (result.key === 'decimals') ctx.decimals = Number(result.value as bigint)
          if (result.key === 'asset') ctx.underlyingAsset = result.value as Address
          if (hasOwner) {
            if (result.key === 'balance') ctx.balance = BigInt(result.value as string)
            if (result.key === 'maxWithdraw') ctx.maxWithdraw = BigInt(result.value as string)
            if (result.key === 'maxRedeem') ctx.maxRedeem = BigInt(result.value as string)
          }
        }
        if (step === 2 && result.key === 'assets') ctx.assets = BigInt(result.value as string)
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
          hasOwner && ctx.balance !== undefined && ctx.assets !== undefined
            ? { balance: ctx.balance, assets: ctx.assets }
            : undefined,
      }
    },
  }
}

export async function resolveErc4626Vault(params: {
  client: StepExecutor
  vault: Address
  owner?: Address
}): Promise<Erc4626VaultResolution> {
  const executor = params.client
  const taskParams: { vault: Address; owner?: Address } = { vault: params.vault }
  if (params.owner !== undefined) taskParams.owner = params.owner
  const [result] = await runMultistepTasks(executor, [buildErc4626Task(taskParams)])
  return result!
}

export async function resolveErc4626VaultsBulk(params: {
  client: StepExecutor
  entries: { vault: Address; owner?: Address }[]
}): Promise<Erc4626VaultResolution[]> {
  if (params.entries.length === 0) return []
  const executor = params.client
  const tasks = params.entries.map((e) => {
    return e.owner !== undefined
      ? buildErc4626Task({ vault: e.vault, owner: e.owner as Address })
      : buildErc4626Task({ vault: e.vault })
  })
  return runMultistepTasks(executor, tasks)
}
