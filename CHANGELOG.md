# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] — 2026-05-31

### Added
- **Core FSM executor** (`runMultistepTasks`) — batched, stepwise multicall orchestration
- **ERC20 handler** — `buildErc20Task`, `resolveErc20Token`, `resolveErc20TokensBulk`
- **ERC4626 handler** — `buildErc4626Task`, `resolveErc4626Vault`, `resolveErc4626VaultsBulk`
  - 2-step pipeline: vault metadata → convertToAssets (when owner provided)
- **Viem engine** (`@halaprix/multistep-multicall/engines/viem`) — via `client.multicall`
- **Ethers v6 engine** (`.../engines/ethers-v6`) — via Multicall3 `aggregate3`
- **Ethers v5 engine** (`.../engines/ethers-v5`) — via Multicall3 `aggregate3`
- Tree-shakeable engine entry points (import one, the other two are excluded)
- Shared `ResolverEngine` type with uniform API across all engines
- JSON ABI shared definitions (`src/abis/erc.ts`)
- Framework-agnostic handler layer for custom executors
- Recursive BigNumber normalization in ethers-v5 engine
- `postbuild.mjs` for `ethers-v5` → `ethers` specifier rewrite
- Bundle size regression test (`bundle-size.test.ts`)
- 37 unit + engine integration tests

[0.1.0]: https://github.com/halaprix/multistep-multicall/releases/tag/v0.1.0
