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

// Per-task settlement (F5)
export { runSettled } from './core/runSettled'
export type { TaskDiagnostics, SettledTaskResult } from './core/runSettled'

// Ref-graph task builder (F2) + typed call specs (F1)
// Note: `DIAGNOSTICS` (runSettled.ts) is intentionally NOT exported here —
// it's an internal channel between defineTask and runSettled, not public API.
export { defineTask } from './core/defineTask'
export type { TaskBuilder, TypedCallSpec } from './core/defineTask'
export type { Ref, WithRefs, ResolveRefs } from './core/refs'

// Error taxonomy
export { DominoCallError, DominoTaskReuseError } from './core/errors'
export type { DominoCallErrorKind, DominoCallErrorOptions } from './core/errors'

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
