/**
 * Ethers v5 engine — implements StepExecutor via Multicall3 aggregate3.
 */

import { Contract, utils } from 'ethers-v5'
import { BigNumber } from 'ethers-v5'
import { MULTICALL3_ADDRESS, multicall3Abi } from '../abis/multicall3'
import { ercCombinedAbi } from '../abis/erc'
import {
  createEncodedExecutor,
  makeResolver,
  type Aggregate3Contract,
  type EncodingInterface,
  type ResolverEngine as ResolverEngineGeneric,
} from './shared'

export type { Erc20TokenResolution, Erc4626VaultResolution } from './shared'

/** ethers v5 accepts plain `string` addresses (no `0x${string}` branding). */
export type ResolverEngine = ResolverEngineGeneric<string>

function normalizeEthersV5Value(value: unknown): unknown {
  if (BigNumber.isBigNumber(value)) return value.toBigInt()
  if (Array.isArray(value)) return value.map(normalizeEthersV5Value)
  return value
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
 * `iface.encodeFunctionData(call.functionName, …)` — they ignore `call.abi`.
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
  const abiInterface = iface ?? new utils.Interface([...ercCombinedAbi])

  const executor = createEncodedExecutor(
    mc3 as unknown as Aggregate3Contract,
    abiInterface as unknown as EncodingInterface,
    normalizeEthersV5Value,
  )

  return makeResolver<string>(executor)
}
