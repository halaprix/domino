/**
 * Ethers v5 engine : implements StepExecutor via Multicall3 aggregate3.
 */

import { Contract, utils } from 'ethers-v5'
import { BigNumber } from 'ethers-v5'
import { MULTICALL3_ADDRESS, multicall3Abi } from '../abis/multicall3'
import { ercCombinedAbi } from '../abis/erc'
import type { StepExecutor, StepCall, RawResult } from '../core/types'
import { runMultistepTasks } from '../core/runMultistepTasks'
import { buildErc20Task, type Erc20TokenResolution } from '../handlers/erc20'
import { buildErc4626Task, type Erc4626VaultResolution } from '../handlers/erc4626'

export type { Erc20TokenResolution, Erc4626VaultResolution }

export interface ResolverEngine {
  resolveErc20(params: { token: string; owner?: string }): Promise<Erc20TokenResolution>
  resolveErc20Bulk(params: {
    entries: { token: string; owner?: string }[]
  }): Promise<Erc20TokenResolution[]>
  resolveErc4626(params: { vault: string; owner?: string }): Promise<Erc4626VaultResolution>
  resolveErc4626Bulk(params: {
    entries: { vault: string; owner?: string }[]
  }): Promise<Erc4626VaultResolution[]>
}

function createEthersV5Executor(mc3: Contract, iface: utils.Interface): StepExecutor {
  return {
    async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
      const encoded = calls.map((call) => ({
        target: call.target,
        allowFailure: true,
        callData: iface.encodeFunctionData(call.functionName, call.args ?? []),
      }))

      const results = (await mc3.aggregate3(encoded)) as Array<{
        success: boolean
        returnData: string
      }>

      return results.map((r, i) => {
        if (!r.success) return { status: 'failure' as const }
        const call = calls[i]
        if (!call) return { status: 'failure' as const }
        try {
          const decoded = iface.decodeFunctionResult(call.functionName, r.returnData)
          let value = Array.isArray(decoded) ? decoded[0] : decoded
          // Normalize ethers v5 BigNumber → bigint so handlers see uniform primitives
          if (BigNumber.isBigNumber(value)) value = value.toBigInt()
          return { status: 'success' as const, value }
        } catch {
          return { status: 'failure' as const }
        }
      })
    },
  }
}

/**
 * Create an ethers v5 ResolverEngine.
 *
 * @param provider - ethers v5 Provider
 * @param multicall3Contract - optional pre-configured Multicall3 Contract
 * @param iface - optional ethers Interface
 *
 * @remarks
 * **StepCall.abi limitation:** ethers executors encode calls via
 * `iface.encodeFunctionData(call.functionName, …)` : they ignore `call.abi`.
 * All function signatures used by your MultistepTasks must be present in
 * the single shared `iface`. If you pass a custom `iface`, include the
 * full combined set of functions your tasks will call.
 */
export function createResolver(
  provider: import('ethers-v5').providers.Provider,
  multicall3Contract?: Contract,
  iface?: utils.Interface,
): ResolverEngine {
  const mc3 = multicall3Contract ?? new Contract(MULTICALL3_ADDRESS, multicall3Abi, provider)

  const abiInterface =
    iface ??
    new utils.Interface([...ercCombinedAbi])

  const executor = createEthersV5Executor(mc3, abiInterface)

  return {
    async resolveErc20(params) {
      const [result] = await runMultistepTasks(executor, [
        buildErc20Task(
          params.owner != null
            ? { token: params.token as `0x${string}`, owner: params.owner as `0x${string}` }
            : { token: params.token as `0x${string}` },
        ),
      ])
      return result!
    },

    async resolveErc20Bulk(params) {
      if (params.entries.length === 0) return []
      const tasks = params.entries.map((e) =>
        buildErc20Task(
          e.owner != null
            ? { token: e.token as `0x${string}`, owner: e.owner as `0x${string}` }
            : { token: e.token as `0x${string}` },
        ),
      )
      return runMultistepTasks(executor, tasks)
    },

    async resolveErc4626(params) {
      const [result] = await runMultistepTasks(executor, [
        buildErc4626Task(
          params.owner != null
            ? { vault: params.vault as `0x${string}`, owner: params.owner as `0x${string}` }
            : { vault: params.vault as `0x${string}` },
        ),
      ])
      return result!
    },

    async resolveErc4626Bulk(params) {
      if (params.entries.length === 0) return []
      const tasks = params.entries.map((e) =>
        buildErc4626Task(
          e.owner != null
            ? { vault: e.vault as `0x${string}`, owner: e.owner as `0x${string}` }
            : { vault: e.vault as `0x${string}` },
        ),
      )
      return runMultistepTasks(executor, tasks)
    },
  }
}
