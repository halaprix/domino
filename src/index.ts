// Core orchestration
export { runMultistepTasks } from './core/runMultistepTasks'
export type {
  StepCall,
  StepResult,
  MultistepTask,
  StepExecutor,
  RawResult,
  Address,
  BlockParam,
  BlockTag,
  Eip1193Provider,
} from './core/types'
export type { BatchOptions } from './core/runMultistepTasks'

// Engine
export { Eip1193Executor } from './engine/eip1193'
export { MulticallResolver } from './engine/resolver'
export type { ResolverEngine } from './engine/resolver'
export {
  MULTICALL3_ADDRESS,
  MULTICALL3_BYTECODE,
  DEPLOYLESS_WRAPPER_BYTECODE,
} from './engine/bytecodes'
export { MULTICALL3_DEPLOYMENTS, shouldUseDeployless } from './engine/deployments'

// ERC20 handler
export { buildErc20Task, resolveErc20Token, resolveErc20TokensBulk } from './handlers/erc20'
export type { Erc20TokenResolution } from './handlers/erc20'

// ERC4626 handler
export { buildErc4626Task, resolveErc4626Vault, resolveErc4626VaultsBulk } from './handlers/erc4626'
export type { Erc4626VaultResolution } from './handlers/erc4626'
