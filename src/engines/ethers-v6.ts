/**
 * Ethers v6 engine — implements StepExecutor via Multicall3 aggregate3.
 */

import { Contract as ContractCls, Interface as InterfaceCls } from 'ethers'
import { ercCombinedAbi } from '../abis/erc'
import { MULTICALL3_ADDRESS, multicall3Abi } from '../abis/multicall3'
import { createEncodedExecutor, type Aggregate3Contract, type EncodingInterface } from './shared'
import { makeResolver, type ResolverEngine } from './resolver'
import type { StepExecutor } from '../core/types'

export type { Erc20TokenResolution, Erc4626VaultResolution, ResolverEngine } from './resolver'
export { MulticallResolver } from './resolver'

/**
 * Create an ethers v6 StepExecutor.
 *
 * Preferred usage:
 *   const executor = createEthersV6Executor(provider)
 *   const resolver = new MulticallResolver(executor)
 *
 * @remarks
 * **StepCall.abi limitation:** ethers executors encode calls via
 * `iface.encodeFunctionData(call.functionName, …)` — they ignore `call.abi`.
 * All function signatures used by your MultistepTasks must be present in
 * the single shared `iface`. If you pass a custom `abiInterface`, include the
 * full combined set of functions your tasks will call.
 */
export function createEthersV6Executor(
  provider: import('ethers').Provider,
  multicall3Contract?: ContractCls,
  abiInterface?: InterfaceCls,
): StepExecutor {
  const mc3 = multicall3Contract ?? new ContractCls(MULTICALL3_ADDRESS, multicall3Abi, provider)
  const iface = abiInterface ?? new InterfaceCls(ercCombinedAbi)

  return createEncodedExecutor(
    mc3 as unknown as Aggregate3Contract,
    iface as unknown as EncodingInterface,
  )
}

/**
 * Convenience factory: creates an ethers v6 executor and wraps it in a MulticallResolver.
 * Equivalent to: new MulticallResolver(createEthersV6Executor(provider, ...))
 */
export function createResolver(
  provider: import('ethers').Provider,
  multicall3Contract?: ContractCls,
  abiInterface?: InterfaceCls,
): ResolverEngine {
  return makeResolver(createEthersV6Executor(provider, multicall3Contract, abiInterface))
}
