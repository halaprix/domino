/**
 * ERC20 handler : framework-agnostic task builder + convenience functions.
 *
 * Builds a MultistepTask that resolves ERC20 token metadata (symbol, decimals)
 * and optionally an owner's balance.
 *
 * Single-step task:
 *   Step 1: symbol(), decimals(), balanceOf(owner?)
 *
 * (G1) Internally reimplemented on `defineTask` — public `buildErc20Task`/
 * `resolveErc20*` signatures and return shapes are unchanged from 1.0. Every
 * contract call is `optional: true`, replicating 1.0's silent-undefined-
 * per-field semantics: a failed call demotes to `undefined` in the result
 * instead of rejecting the whole resolution. The pre-migration hand-written
 * implementation is preserved as the parity-test oracle at
 * `src/__tests__/fixtures/legacy-handlers/erc20.ts` (deleted after one minor
 * — see its header comment).
 *
 * **Accepted behavioral delta (documented, not parity-breaking — see
 * `src/__tests__/parity-g1.test.ts`):** under `runSettled`, each `optional`
 * call's `DominoCallError` is now retained in `diagnostics.optionalFailures`
 * instead of being silently destroyed (the legacy implementation carried no
 * diagnostics channel at all, so `runSettled` always reported `[]` for these
 * tasks). Resolved VALUES are byte-for-byte unchanged either way. New calls
 * are also dedup-ELIGIBLE (`TypedCallSpec`-compiled) — `{ dedupe: true }`
 * can now merge identical calls across bulk entries; legacy hand-authored
 * `StepCall`s were never eligible.
 */

import type { Address, MultistepTask, BlockParam } from '../core/types'
import { defineTask } from '../core/defineTask'
import { runMultistepTasks } from '../core/runMultistepTasks'
import type { ExecutorParam } from './executorParam'
import { resolveExecutor } from './executorParam'

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

// ─── Internal helpers ─────────────────────────────────────────────────────────

// Typed accessor helpers — safe coercion from the untyped call result. These
// replace `as T` casts; returning undefined instead of producing wrong data
// when an executor returns an unexpected value type. Unchanged from the
// pre-defineTask implementation (see the legacy oracle) — reused here via
// `t.derive` so 1.0's defensive coercion behavior survives the migration
// byte-for-byte (this is what the compat suite pins).
const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const asBigInt = (v: unknown): bigint | undefined => (typeof v === 'bigint' ? v : undefined)
const asNumber = (v: unknown): number | undefined => {
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

// ─── Domain layer ─────────────────────────────────────────────────────────────
// buildErc20Task — pure MultistepTask factory; no orchestration dependency.
// Safe to use in custom pipelines, test doubles, and non-engine contexts.

export function buildErc20Task(params: {
  token: Address
  owner?: Address
}): MultistepTask<Erc20TokenResolution> {
  const { token, owner } = params

  return defineTask((t) => {
    // Creation order matters (parity with 1.0's step-1 call order, and with
    // positional mock-executor fixtures): symbol, decimals, balanceOf.
    const symbolCall = t.call({ target: token, abi: erc20Abi, functionName: 'symbol', optional: true })
    const decimalsCall = t.call({ target: token, abi: erc20Abi, functionName: 'decimals', optional: true })

    const symbol = t.derive([symbolCall], asString)
    const decimals = t.derive([decimalsCall], asNumber)

    if (!owner) {
      return { symbol, decimals, balance: undefined }
    }

    const balanceCall = t.call({
      target: token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [owner],
      optional: true,
    })
    const balance = t.derive([balanceCall], asBigInt)

    return { symbol, decimals, balance }
  })
}

// ─── Application layer ────────────────────────────────────────────────────────
// Convenience resolvers that compose buildErc20Task with runMultistepTasks.
// Use from engine entry points or when a StepExecutor is already available.

export async function resolveErc20Token(
  params: ExecutorParam & {
    token: Address
    owner?: Address
    block?: BlockParam
  },
): Promise<Erc20TokenResolution> {
  const executor = resolveExecutor(params)
  const taskParams: { token: Address; owner?: Address } = { token: params.token }
  if (params.owner !== undefined) taskParams.owner = params.owner
  const [result] = await runMultistepTasks(executor, [buildErc20Task(taskParams)], {
    ...(params.block !== undefined ? { block: params.block } : {}),
  })
  return result!
}

/**
 * Canonical name for bulk ERC20 token resolution (F11).
 * Accepts both `executor:` (preferred) and `client:` (deprecated, F10) parameters.
 */
export async function resolveErc20Bulk(
  params: ExecutorParam & {
    entries: { token: Address; owner?: Address }[]
    batchSize?: number
    block?: BlockParam
  },
): Promise<Erc20TokenResolution[]> {
  const executor = resolveExecutor(params)
  if (params.entries.length === 0) return []
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

/**
 * @deprecated Use `resolveErc20Bulk` instead. Forever-in-1.x alias (F11).
 */
export const resolveErc20TokensBulk = resolveErc20Bulk
