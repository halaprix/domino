/**
 * ERC20 handler : framework-agnostic task builder + convenience functions.
 *
 * Builds a MultistepTask that resolves ERC20 token metadata (symbol, decimals)
 * and optionally an owner's balance.
 *
 * Single-step task:
 *   Step 1: symbol(), decimals(), balanceOf(owner?)
 */

import type { Address, MultistepTask, StepCall, StepResult, StepExecutor, BlockParam } from '../core/types'
import { runMultistepTasks } from '../core/runMultistepTasks'

/** Minimal ERC20 ABI — only the functions used by buildErc20Task. */
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

// ─── Value types ──────────────────────────────────────────────────────────────

export interface Erc20TokenResolution {
  symbol: string | undefined
  decimals: number | undefined
  balance: bigint | undefined
}

type Erc20Context = {
  symbol?: string
  decimals?: number
  balance?: bigint
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

// Typed accessor helpers — safe coercion from the untyped RawResult.value.
// These replace `as T` casts; returning undefined instead of producing wrong data
// when an executor returns an unexpected value type.
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

// ─── Domain layer ─────────────────────────────────────────────────────────────
// buildErc20Task — pure MultistepTask factory; no orchestration dependency.
// Safe to use in custom pipelines, test doubles, and non-engine contexts.

export function buildErc20Task(params: {
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
  }
}

// ─── Application layer ────────────────────────────────────────────────────────
// Convenience resolvers that compose buildErc20Task with runMultistepTasks.
// Use from engine entry points or when a StepExecutor is already available.

export async function resolveErc20Token(params: {
  client: StepExecutor
  token: Address
  owner?: Address
  block?: BlockParam
}): Promise<Erc20TokenResolution> {
  const executor = params.client
  const taskParams: { token: Address; owner?: Address } = { token: params.token }
  if (params.owner !== undefined) taskParams.owner = params.owner
  const [result] = await runMultistepTasks(executor, [buildErc20Task(taskParams)], {
    ...(params.block !== undefined ? { block: params.block } : {}),
  })
  return result!
}

export async function resolveErc20TokensBulk(params: {
  client: StepExecutor
  entries: { token: Address; owner?: Address }[]
  batchSize?: number
  block?: BlockParam
}): Promise<Erc20TokenResolution[]> {
  if (params.entries.length === 0) return []
  const executor = params.client
  const tasks = params.entries.map((e) => {
    return e.owner !== undefined
      ? buildErc20Task({ token: e.token, owner: e.owner as Address })
      : buildErc20Task({ token: e.token })
  })
  return runMultistepTasks(
    executor,
    tasks,
    {
      ...(params.batchSize !== undefined ? { batchSize: params.batchSize } : {}),
      ...(params.block !== undefined ? { block: params.block } : {}),
    },
  )
}
