/**
 * Ethers v6 engine — implements StepExecutor via Multicall3 aggregate3.
 */

import { Contract as ContractCls, Interface as InterfaceCls } from 'ethers'
import { erc20Abi, erc4626Abi, type Address } from 'viem'
import { MULTICALL3_ADDRESS, multicall3Abi } from '../abis/multicall3'
import type { StepExecutor, StepCall, RawResult } from '../core/types'
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

function createEthersV6Executor(mc3: ContractCls, iface: InterfaceCls): StepExecutor {
  return {
    async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
      const encoded = calls.map((call) => ({
        target: call.target,
        allowFailure: true,
        callData: iface.encodeFunctionData(call.functionName, call.args ?? []),
      }))

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const results = (await (mc3 as any).aggregate3(encoded)) as Array<{
        success: boolean
        returnData: string
      }>

      return results.map((r, i) => {
        if (!r.success) return { status: 'failure' as const }
        const call = calls[i]
        if (!call) return { status: 'failure' as const }
        try {
          const decoded = iface.decodeFunctionResult(call.functionName, r.returnData)
          const value = Array.isArray(decoded) ? decoded[0] : decoded
          return { status: 'success' as const, value }
        } catch {
          return { status: 'failure' as const }
        }
      })
    },
  }
}

export function createResolver(
  provider: import('ethers').Provider,
  multicall3Contract?: ContractCls,
  abiInterface?: InterfaceCls,
): ResolverEngine {
  const mc3 = multicall3Contract ?? new ContractCls(MULTICALL3_ADDRESS, multicall3Abi, provider)
  const iface: InterfaceCls = abiInterface ?? new InterfaceCls([...erc20Abi, ...erc4626Abi])

  const executor = createEthersV6Executor(mc3, iface)

  return {
    async resolveErc20(params) {
      const [result] = await runMultistepTasks(executor, [
        buildErc20Task(params.owner != null ? params : { token: params.token }),
      ])
      return result!
    },

    async resolveErc20Bulk(params) {
      if (params.entries.length === 0) return []
      const tasks = params.entries.map((e) =>
        buildErc20Task(e.owner != null ? e : { token: e.token }),
      )
      return runMultistepTasks(executor, tasks)
    },

    async resolveErc4626(params) {
      const [result] = await runMultistepTasks(executor, [
        buildErc4626Task(params.owner != null ? params : { vault: params.vault }),
      ])
      return result!
    },

    async resolveErc4626Bulk(params) {
      if (params.entries.length === 0) return []
      const tasks = params.entries.map((e) =>
        buildErc4626Task(e.owner != null ? e : { vault: e.vault }),
      )
      return runMultistepTasks(executor, tasks)
    },
  }
}
