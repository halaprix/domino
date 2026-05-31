/**
 * Shared engine plumbing.
 *
 * Every engine (viem, ethers v5/v6) differs only in how it turns StepCalls into
 * on-chain results — i.e. its `StepExecutor`. The four `resolveX` methods and the
 * owner-compaction boilerplate are identical, so they live here once.
 */

import type { Address, StepCall, StepExecutor, RawResult } from '../core/types'
import { runMultistepTasks } from '../core/runMultistepTasks'
import { buildErc20Task, type Erc20TokenResolution } from '../handlers/erc20'
import { buildErc4626Task, type Erc4626VaultResolution } from '../handlers/erc4626'

export type { Erc20TokenResolution, Erc4626VaultResolution }

/** Minimal structural view of an ethers Interface (v5 or v6). */
export interface EncodingInterface {
  encodeFunctionData(functionName: string, args: readonly unknown[]): string
  decodeFunctionResult(
    functionName: string,
    data: string,
  ): { readonly length: number; readonly [index: number]: unknown }
}

/** Minimal structural view of a Multicall3 contract's `aggregate3`. */
export interface Aggregate3Contract {
  aggregate3(
    calls: { target: string; allowFailure: boolean; callData: string }[],
  ): Promise<Array<{ success: boolean; returnData: string }>>
}

/**
 * Executor shared by the ethers v5 and v6 engines: encode each call with the
 * given Interface, batch through Multicall3.aggregate3, then decode each result.
 * `normalize` lets v5 convert BigNumber → bigint; v6 passes values through.
 */
export function createEncodedExecutor(
  mc3: Aggregate3Contract,
  iface: EncodingInterface,
  normalize: (value: unknown) => unknown = (v) => v,
): StepExecutor {
  return {
    async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
      const encoded = calls.map((call) => ({
        target: call.target,
        allowFailure: true,
        callData: iface.encodeFunctionData(call.functionName, call.args ?? []),
      }))

      const results = await mc3.aggregate3(encoded)

      return results.map((r, i) => {
        if (!r.success) return { status: 'failure' as const }
        const call = calls[i]
        if (!call) return { status: 'failure' as const }
        try {
          const decoded = iface.decodeFunctionResult(call.functionName, r.returnData)
          const value = normalize(decoded.length === 1 ? decoded[0] : decoded)
          return { status: 'success' as const, value }
        } catch {
          return { status: 'failure' as const }
        }
      })
    },
  }
}

/**
 * Uniform resolver API exposed by every engine.
 *
 * `TAddr` is the address representation the engine accepts — `Address`
 * (`0x${string}`) for viem/ethers v6, plain `string` for ethers v5.
 */
export interface ResolverEngine<TAddr extends string = Address> {
  resolveErc20(params: { token: TAddr; owner?: TAddr }): Promise<Erc20TokenResolution>
  resolveErc20Bulk(params: {
    entries: { token: TAddr; owner?: TAddr }[]
  }): Promise<Erc20TokenResolution[]>
  resolveErc4626(params: { vault: TAddr; owner?: TAddr }): Promise<Erc4626VaultResolution>
  resolveErc4626Bulk(params: {
    entries: { vault: TAddr; owner?: TAddr }[]
  }): Promise<Erc4626VaultResolution[]>
}

// Build task params while omitting `owner` when absent — required under
// exactOptionalPropertyTypes, which forbids an explicit `owner: undefined`.
function erc20Params(token: string, owner?: string): { token: Address; owner?: Address } {
  return owner != null
    ? { token: token as Address, owner: owner as Address }
    : { token: token as Address }
}

function erc4626Params(vault: string, owner?: string): { vault: Address; owner?: Address } {
  return owner != null
    ? { vault: vault as Address, owner: owner as Address }
    : { vault: vault as Address }
}

/**
 * Wire a `StepExecutor` up to the standard four resolver methods.
 * This is the entire body of every engine's `createResolver` once the
 * engine-specific executor has been constructed.
 */
export function makeResolver<TAddr extends string = Address>(
  executor: StepExecutor,
): ResolverEngine<TAddr> {
  return {
    async resolveErc20({ token, owner }) {
      const [result] = await runMultistepTasks(executor, [buildErc20Task(erc20Params(token, owner))])
      return result!
    },

    async resolveErc20Bulk({ entries }) {
      if (entries.length === 0) return []
      const tasks = entries.map((e) => buildErc20Task(erc20Params(e.token, e.owner)))
      return runMultistepTasks(executor, tasks)
    },

    async resolveErc4626({ vault, owner }) {
      const [result] = await runMultistepTasks(executor, [
        buildErc4626Task(erc4626Params(vault, owner)),
      ])
      return result!
    },

    async resolveErc4626Bulk({ entries }) {
      if (entries.length === 0) return []
      const tasks = entries.map((e) => buildErc4626Task(erc4626Params(e.vault, e.owner)))
      return runMultistepTasks(executor, tasks)
    },
  }
}
