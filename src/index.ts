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

// ERC20 handler
export { buildErc20Task, resolveErc20Token, resolveErc20TokensBulk } from './handlers/erc20'
export type { Erc20TokenResolution } from './handlers/erc20'

// ERC4626 handler
export { buildErc4626Task, resolveErc4626Vault, resolveErc4626VaultsBulk } from './handlers/erc4626'
export type { Erc4626VaultResolution } from './handlers/erc4626'

// Engines are NOT re-exported from root to keep the main bundle small.
// Import from subpaths instead:
//   import { createResolver } from '@halaprix/multistep-multicall/engines/viem'
//   import { createResolver } from '@halaprix/multistep-multicall/engines/ethers-v6'
//   import { createResolver } from '@halaprix/multistep-multicall/engines/ethers-v5'
