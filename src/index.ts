/**
 * multistep-multicall
 *
 * A finite state machine executor wrapping viem's Multicall3 for
 * sequential, state-dependent contract reads.
 */

// Re-exports added in Task 2 (Core FSM Executor + Handlers)
export type { MultistepTask } from "./multistepMulticall";
export type { StepCall, StepResult } from "./multistepMulticall";
export { runMultistepTasks } from "./multistepMulticall";

export type {
  resolveErc4626Vault,
  resolveErc4626VaultsBulk,
} from "./handlers/erc4626";

export type {
  resolveErc20Token,
  resolveErc20TokensBulk,
} from "./handlers/erc20";
