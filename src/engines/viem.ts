/**
 * Viem engine — implements StepExecutor via viem's built-in multicall3.
 */

import { type Address, type PublicClient } from 'viem'
import type { Abi } from 'viem'
import type { StepExecutor, StepCall, RawResult } from '../core/types'
import { MULTICALL3_ADDRESS } from '../abis/multicall3'
import { runMultistepTasks } from '../core/runMultistepTasks'
import { buildErc20Task, type Erc20TokenResolution } from '../handlers/erc20'
import { buildErc4626Task, type Erc4626VaultResolution } from '../handlers/erc4626'

export type { Erc20TokenResolution, Erc4626VaultResolution }

export interface ResolverEngine {
  resolveErc20(params: { token: Address; owner?: Address }): Promise<Erc20TokenResolution>
  resolveErc20Bulk(params: {
    entries: { token: Address; owner?: Address }[]
  }): Promise<Erc20TokenResolution[]>
  resolveErc4626(params: { vault: Address; owner?: Address }): Promise<Erc4626VaultResolution>
  resolveErc4626Bulk(params: {
    entries: { vault: Address; owner?: Address }[]
  }): Promise<Erc4626VaultResolution[]>
}

function createViemExecutor(client: PublicClient): StepExecutor {
  return {
    async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
      const contracts = calls.map((call) => ({
        address: call.target,
        abi: call.abi as Abi,
        functionName: call.functionName,
        args: call.args ?? [],
      }))

      const results = await client.multicall({
        contracts: contracts as Parameters<typeof client.multicall>[0]['contracts'],
        allowFailure: true,
        // Pass the canonical Multicall3 address explicitly so the engine works
        // even when the client has no chain (or a chain without multicall3) configured.
        multicallAddress: MULTICALL3_ADDRESS,
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

export function createResolver(client: PublicClient): ResolverEngine {
  const executor = createViemExecutor(client)

  return {
    async resolveErc20(params) {
      const taskParams: { token: Address; owner?: Address } = {
        token: params.token,
        ...(params.owner != null && { owner: params.owner }),
      }
      const [result] = await runMultistepTasks(executor, [buildErc20Task(taskParams)])
      return result!
    },

    async resolveErc20Bulk(params) {
      if (params.entries.length === 0) return []
      const tasks = params.entries.map((e) => {
        const p: { token: Address; owner?: Address } = {
          token: e.token,
          ...(e.owner != null && { owner: e.owner }),
        }
        return buildErc20Task(p)
      })
      return runMultistepTasks(executor, tasks)
    },

    async resolveErc4626(params) {
      const taskParams: { vault: Address; owner?: Address } = {
        vault: params.vault,
        ...(params.owner != null && { owner: params.owner }),
      }
      const [result] = await runMultistepTasks(executor, [buildErc4626Task(taskParams)])
      return result!
    },

    async resolveErc4626Bulk(params) {
      if (params.entries.length === 0) return []
      const tasks = params.entries.map((e) => {
        const p: { vault: Address; owner?: Address } = {
          vault: e.vault,
          ...(e.owner != null && { owner: e.owner }),
        }
        return buildErc4626Task(p)
      })
      return runMultistepTasks(executor, tasks)
    },
  }
}
