/**
 * Ethers v6 engine — implements StepExecutor via Multicall3 aggregate3.
 */

import { Contract as ContractCls, Interface as InterfaceCls } from 'ethers'
import { ercCombinedAbi } from '../abis/erc'
import { MULTICALL3_ADDRESS, multicall3Abi } from '../abis/multicall3'
import {
  createEncodedExecutor,
  makeResolver,
  type Aggregate3Contract,
  type EncodingInterface,
  type ResolverEngine,
} from './shared'

export type { Erc20TokenResolution, Erc4626VaultResolution, ResolverEngine } from './shared'

/**
 * Create an ethers v6 ResolverEngine.
 *
 * @param provider - ethers v6 Provider
 * @param multicall3Contract - optional pre-configured Multicall3 Contract
 * @param abiInterface - optional ethers Interface
 *
 * @remarks
 * **StepCall.abi limitation:** ethers executors encode calls via
 * `iface.encodeFunctionData(call.functionName, …)` — they ignore `call.abi`.
 * All function signatures used by your MultistepTasks must be present in
 * the single shared `iface`. If you pass a custom `abiInterface`, include the
 * full combined set of functions your tasks will call.
 */
export function createResolver(
  provider: import('ethers').Provider,
  multicall3Contract?: ContractCls,
  abiInterface?: InterfaceCls,
): ResolverEngine {
  const mc3 = multicall3Contract ?? new ContractCls(MULTICALL3_ADDRESS, multicall3Abi, provider)
  const iface = abiInterface ?? new InterfaceCls(ercCombinedAbi)

  const executor = createEncodedExecutor(
    mc3 as unknown as Aggregate3Contract,
    iface as unknown as EncodingInterface,
  )

  return makeResolver(executor)
}
