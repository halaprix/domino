/**
 * Viem engine — implements StepExecutor via viem's built-in multicall3.
 */

import { type PublicClient } from 'viem'
import type { StepExecutor, StepCall, RawResult } from '../core/types'
import { MULTICALL3_ADDRESS } from '../abis/multicall3'
import { makeResolver, type ResolverEngine } from './resolver'

export type { Erc20TokenResolution, Erc4626VaultResolution, ResolverEngine } from './resolver'
export { MulticallResolver } from './resolver'

/**
 * Create a viem-backed StepExecutor.
 *
 * Preferred usage:
 *   const executor = createViemExecutor(client)
 *   const resolver = new MulticallResolver(executor)
 */
export function createViemExecutor(client: PublicClient): StepExecutor {
  return {
    async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
      const contracts = calls.map((call) => ({
        address: call.target,
        abi: call.abi,
        functionName: call.functionName,
        args: call.args ?? [],
      }))

      const results = await client.multicall({
        contracts: contracts as Parameters<typeof client.multicall>[0]['contracts'],
        allowFailure: true,
        // Prefer the chain's own Multicall3 address (covers custom/non-canonical
        // deployments). Only fall back to the canonical address when the client
        // has no chain — or a chain without multicall3 — configured.
        ...(client.chain?.contracts?.multicall3
          ? {}
          : { multicallAddress: MULTICALL3_ADDRESS }),
      })

      return results.map((r) => {
        if (r.status === 'failure') return { status: 'failure' as const }
        // viem's multicall already unwraps single-output function returns
        // (e.g. symbol() → 'USDC', not ['USDC'])
        return { status: 'success' as const, value: r.result }
      })
    },
  }
}

/**
 * Convenience factory: creates a viem executor and wraps it in a MulticallResolver.
 * Equivalent to: new MulticallResolver(createViemExecutor(client))
 */
export function createResolver(client: PublicClient): ResolverEngine {
  return makeResolver(createViemExecutor(client))
}
