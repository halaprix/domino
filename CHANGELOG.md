# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Breaking

- **Package renamed** from `@halaprix/multistep-multicall` to `@halaprix/domino`.
- **Engine subpath imports flattened**: `…/engines/viem` → `…/viem`, `…/engines/ethers-v6` → `…/ethers-v6`, `…/engines/ethers-v5` → `…/ethers-v5`.

### Added

- **Configurable batch size** (`batchSize` option on `runMultistepTasks`) — splits oversized steps into sequential batches to stay under Multicall3 gas limits. Default: 100 calls per batch.
- **Bulk API batch forwarding** — `resolveErc20Bulk` and `resolveErc4626Bulk` now accept an optional `batchSize` parameter forwarded to `runMultistepTasks`.
- `buildErc20Task`, `buildErc4626Task`, and `Address` exported from the root package entry.
- `BatchOptions` type exported from root entry.
- `CLAUDE.md` — architecture and AI context document.
- `docs/api-reference.md` — full API reference covering both layers and return types.
- `docs/benchmarks.md` — bundle size comparison and RPC call-count benchmarks.
- Benchmark script (`npm run benchmark`) for measuring RPC reduction at scale.
- Interactive ERC4626 demo (`docs/index.html`) with wallet connect and FSM visualization.
- `prepublishOnly` hook — enforces `build + test` before `npm publish`.
- `publishConfig`, `engines` (Node ≥ 18), `sideEffects: false`, and `files` fields in `package.json`.

### Fixed

- `batchSize: 0` or negative no longer causes an infinite loop — throws `"batchSize must be a positive integer"`.
- Non-integer `batchSize` no longer silently drops results via fractional array indices.
- Multicall3 `Call3` tuple field order corrected in the demo (wrong order produced an incorrect function selector causing every `staticCall` to revert).
- `ethers-v5` test now imports types from `ethers-v5` — fixes a silent typecheck failure on 5 call sites.
- CI `Type-check` step now runs real `tsc --noEmit`; `Build` step restored before `Test` so `dist/` exists for bundle-size tests on a clean checkout.
- `encodeFunctionData` errors in the ethers executor are now caught per-call and routed as `{ status: 'failure' }` instead of aborting the entire step batch.
- `position.assets` is now `bigint | undefined` — correctly represents the case where `balanceOf` succeeds but `convertToAssets` reverts.

## [0.1.0] — 2026-05-31

### Added
- **Core FSM executor** (`runMultistepTasks`) — batched, stepwise multicall orchestration
- **ERC20 handler** — `buildErc20Task`, `resolveErc20Token`, `resolveErc20TokensBulk`
- **ERC4626 handler** — `buildErc4626Task`, `resolveErc4626Vault`, `resolveErc4626VaultsBulk`
  - 2-step pipeline: vault metadata → convertToAssets (when owner provided)
- **Viem engine** (`@halaprix/domino/viem`) — via `client.multicall`
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

[0.1.0]: https://github.com/halaprix/domino/releases/tag/v0.1.0
