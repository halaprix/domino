/**
 * Ethers v5 engine — implements StepExecutor via Multicall3 aggregate3.
 */

import { Contract, utils } from 'ethers-v5'
import { BigNumber } from 'ethers-v5'
import { MULTICALL3_ADDRESS, multicall3Abi } from '../abis/multicall3'
import { ercCombinedAbi } from '../abis/erc'
import { createEncodedExecutor, type Aggregate3Contract, type EncodingInterface } from './shared'
import {
  MulticallResolver,
  makeResolver,
  type ResolverEngine as ResolverEngineGeneric,
} from './resolver'
import type { StepExecutor } from '../core/types'

export type { Erc20TokenResolution, Erc4626VaultResolution } from './resolver'
export { MulticallResolver } from './resolver'

/** ethers v5 accepts plain `string` addresses (no `0x${string}` branding). */
export type ResolverEngine = ResolverEngineGeneric<string>

function normalizeEthersV5Value(value: unknown): unknown {
  if (BigNumber.isBigNumber(value)) return value.toBigInt()
  if (Array.isArray(value)) {
    const arr = value.map(normalizeEthersV5Value)
    for (const key in value) {
      if (isNaN(Number(key))) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(arr as any)[key] = normalizeEthersV5Value((value as any)[key])
      }
    }
    return arr
  }
  return value
}

/**
 * Create an ethers v5 StepExecutor.
 *
 * Preferred usage:
 *   const executor = createEthersV5Executor(provider)
 *   const resolver = new MulticallResolver(executor)
 *
 * @remarks
 * **StepCall.abi limitation:** ethers executors encode calls via
 * `iface.encodeFunctionData(call.functionName, …)` — they ignore `call.abi`.
 * All function signatures used by your MultistepTasks must be present in
 * the single shared `iface`. If you pass a custom `iface`, include the
 * full combined set of functions your tasks will call.
 */
export function createEthersV5Executor(
  provider: import('ethers-v5').providers.Provider,
  multicall3Contract?: Contract,
  iface?: utils.Interface,
): StepExecutor {
  const mc3 = multicall3Contract ?? new Contract(MULTICALL3_ADDRESS, multicall3Abi, provider)
  const abiInterface = iface ?? new utils.Interface([...ercCombinedAbi])

  return createEncodedExecutor(
    mc3 as unknown as Aggregate3Contract,
    abiInterface as unknown as EncodingInterface,
    normalizeEthersV5Value,
  )
}

/**
 * Convenience factory: creates an ethers v5 executor and wraps it in a MulticallResolver.
 * Equivalent to: new MulticallResolver(createEthersV5Executor(provider, ...))
 */
export function createResolver(
  provider: import('ethers-v5').providers.Provider,
  multicall3Contract?: Contract,
  iface?: utils.Interface,
): ResolverEngine {
  return makeResolver<string>(createEthersV5Executor(provider, multicall3Contract, iface))
}
