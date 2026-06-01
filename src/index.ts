// Core orchestration
export { runMultistepTasks } from './core/runMultistepTasks'
export type {
  StepCall,
  StepResult,
  MultistepTask,
  StepExecutor,
  RawResult,
  Address,
} from './core/types'
export type { BatchOptions } from './core/runMultistepTasks'

// Application-layer resolver (engine-agnostic)
export { MulticallResolver } from './engines/resolver'
export type { ResolverEngine } from './engines/resolver'

// ERC20 handler
export { buildErc20Task, resolveErc20Token, resolveErc20TokensBulk } from './handlers/erc20'
export type { Erc20TokenResolution } from './handlers/erc20'

// ERC4626 handler
export { buildErc4626Task, resolveErc4626Vault, resolveErc4626VaultsBulk } from './handlers/erc4626'
export type { Erc4626VaultResolution } from './handlers/erc4626'

// Engines export executors + createResolver convenience from their subpaths:
//   import { createViemExecutor, createResolver } from '@halaprix/domino/viem'
//   import { createEthersV6Executor, createResolver } from '@halaprix/domino/ethers-v6'
//   import { createEthersV5Executor, createResolver } from '@halaprix/domino/ethers-v5'
