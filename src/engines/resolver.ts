/**
 * Application-layer resolver — wires a StepExecutor to the domain handlers.
 *
 * This module is the boundary between the engine (infrastructure) layer and
 * the handler (domain/application) layer. Engines produce a StepExecutor; the
 * MulticallResolver consumes one and exposes the typed resolve methods.
 *
 * Usage (new preferred pattern):
 *   import { createViemExecutor } from '@halaprix/multistep-multicall/engines/viem'
 *   import { MulticallResolver } from '@halaprix/multistep-multicall'
 *
 *   const executor = createViemExecutor(client)
 *   const resolver = new MulticallResolver(executor)
 *   await resolver.resolveErc20({ token: '0x...' })
 *
 * The legacy createResolver(client) convenience in each engine still works and
 * is equivalent to: new MulticallResolver(createXxxExecutor(client)).
 */

import type { Address, StepExecutor, MultistepTask } from '../core/types'
import { runMultistepTasks, type BatchOptions } from '../core/runMultistepTasks'
import {
  resolveErc20Token,
  resolveErc20TokensBulk,
  type Erc20TokenResolution,
} from '../handlers/erc20'
import {
  resolveErc4626Vault,
  resolveErc4626VaultsBulk,
  type Erc4626VaultResolution,
} from '../handlers/erc4626'

export type { Erc20TokenResolution, Erc4626VaultResolution }

/**
 * Uniform resolver API exposed by every engine.
 *
 * `TAddr` is the address representation the engine accepts — `Address`
 * (`0x${string}`) for viem/ethers v6, plain `string` for ethers v5.
 */
export interface ResolverEngine<TAddr extends string = Address> {
  /**
   * Generic extension point — execute any MultistepTask(s) against this executor.
   * Use this for custom token standards (ERC721, Uniswap pairs, etc.) beyond
   * the built-in ERC20/ERC4626 conveniences.
   */
  run<T>(tasks: MultistepTask<T>[], options?: BatchOptions): Promise<T[]>
  resolveErc20(params: { token: TAddr; owner?: TAddr }): Promise<Erc20TokenResolution>
  resolveErc20Bulk(params: {
    entries: { token: TAddr; owner?: TAddr }[]
    batchSize?: number
  }): Promise<Erc20TokenResolution[]>
  resolveErc4626(params: { vault: TAddr; owner?: TAddr }): Promise<Erc4626VaultResolution>
  resolveErc4626Bulk(params: {
    entries: { vault: TAddr; owner?: TAddr }[]
    batchSize?: number
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
 * Engine-agnostic resolver. Pass any StepExecutor (viem, ethers v5/v6,
 * or a custom implementation) and get the full resolve API.
 *
 * This class replaces the internal makeResolver() function, making the
 * executor ↔ resolver composition an explicit, inspectable object.
 */
export class MulticallResolver<TAddr extends string = Address>
  implements ResolverEngine<TAddr>
{
  constructor(private readonly _executor: StepExecutor) {}

  get executor(): StepExecutor {
    return this._executor
  }

  /**
   * @see runMultistepTasks for step-count batching behaviour — tasks with
   * different maxStep values all finalize together after the global max step.
   */
  run<T>(tasks: MultistepTask<T>[], options?: BatchOptions): Promise<T[]> {
    return runMultistepTasks(this._executor, tasks, options)
  }

  resolveErc20(params: { token: TAddr; owner?: TAddr }): Promise<Erc20TokenResolution> {
    return resolveErc20Token({
      client: this._executor,
      ...erc20Params(params.token, params.owner),
    })
  }

  resolveErc20Bulk(params: {
    entries: { token: TAddr; owner?: TAddr }[]
    batchSize?: number
  }): Promise<Erc20TokenResolution[]> {
    return resolveErc20TokensBulk({
      client: this._executor,
      entries: params.entries.map((e) => erc20Params(e.token, e.owner)),
      ...(params.batchSize !== undefined ? { batchSize: params.batchSize } : {}),
    })
  }

  resolveErc4626(params: { vault: TAddr; owner?: TAddr }): Promise<Erc4626VaultResolution> {
    return resolveErc4626Vault({
      client: this._executor,
      ...erc4626Params(params.vault, params.owner),
    })
  }

  resolveErc4626Bulk(params: {
    entries: { vault: TAddr; owner?: TAddr }[]
    batchSize?: number
  }): Promise<Erc4626VaultResolution[]> {
    return resolveErc4626VaultsBulk({
      client: this._executor,
      entries: params.entries.map((e) => erc4626Params(e.vault, e.owner)),
      ...(params.batchSize !== undefined ? { batchSize: params.batchSize } : {}),
    })
  }
}

/**
 * @deprecated Use `new MulticallResolver(executor)` instead. Kept for backward
 * compatibility — equivalent to `new MulticallResolver(executor)`.
 */
export function makeResolver<TAddr extends string = Address>(
  executor: StepExecutor,
): ResolverEngine<TAddr> {
  return new MulticallResolver<TAddr>(executor)
}
