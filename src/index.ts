// Core orchestration
export { runMultistepTasks } from "./core/runMultistepTasks";
export type { StepCall, StepResult, MultistepTask, StepExecutor } from "./core/types";

// ERC20 handler
export { resolveErc20Token, resolveErc20TokensBulk } from "./handlers/erc20";
export type { Erc20TokenResolution } from "./handlers/erc20";

// ERC4626 handler
export { resolveErc4626Vault, resolveErc4626VaultsBulk } from "./handlers/erc4626";
export type { Erc4626VaultResolution } from "./handlers/erc4626";

// Viem engine
export { createResolver } from "./engines/viem";
export type { ResolverEngine } from "./engines/viem";

// Ethers v6 engine
export { createResolver as createEthersV6Resolver } from "./engines/ethers-v6";

// Ethers v5 engine
export { createResolver as createEthersV5Resolver } from "./engines/ethers-v5";
