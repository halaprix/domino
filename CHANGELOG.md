# Changelog

All notable changes to this project will be documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.0] — 2026-06-06

### Added
- **Block tags**: query historical state at any `blockNumber`, `blockTag`, or `blockHash` (EIP-1898).
- **Deployless multicall**: automatic fallback when Multicall3 wasn't deployed at the target block. Uses viem's `deploylessCallViaBytecodeBytecode` wrapper — a CREATE-style `eth_call` that deploys Multicall3 and calls `aggregate3` in one transaction.
- **EIP-1193 provider**: works with any provider implementing `request({ method, params })` — viem, ethers, window.ethereum.
- **Per-chain deployment registry**: 8 major EVM chains, auto-detected from `eth_chainId`.
- `Eip1193Executor` — single engine replacing viem/ethers-v5/ethers-v6 executors.
- `BlockParam`, `BlockTag`, `Eip1193Provider` types exported.
- `MULTICALL3_BYTECODE`, `DEPLOYLESS_WRAPPER_BYTECODE`, `MULTICALL3_DEPLOYMENTS` exported for advanced use.
- `shouldUseDeployless()` helper exported.
- `MIGRATION.md` with v0.1.0 → v1.0.0 migration guide.

### Changed
- `StepExecutor.executeMulticall()` now accepts optional `block` parameter.
- `runMultistepTasks` — `BatchOptions` now includes `block?: BlockParam`.
- `resolveErc20Token`, `resolveErc4626Vault` etc. — optional `block` in params (backward-compatible).
- `viem` moved from optional peer dependency to hard dependency (tree-shakes to ~3KB for ABI utils).

### Removed
- **Ethers v5 engine** — use `Eip1193Executor` with an ethers provider instead.
- **Ethers v6 engine** — same.
- **Viem engine** (`createViemExecutor`, `createResolver`) — use `new Eip1193Executor(provider)`.
- Subpath exports: `@halaprix/domino/viem`, `/ethers-v6`, `/ethers-v5`.
- `src/abis/` directory — ABIs inlined in handlers and engine.

### Fixed
- Multi-output function results now properly unwrapped (single-element arrays → scalar value).
- chainId detection uses promise-based lock to prevent concurrent `eth_chainId` calls.
- `refreshChainId()` method for wallet chain switches.

## [0.1.0] — 2026-06-01

First public release of `@halaprix/domino`.

### Added

- **Core FSM executor** (`runMultistepTasks`) — batched, stepwise multicall orchestration. O(M) RPC calls where M = maxStep, vs O(N×M) for naive sequential reads.
- **ERC20 handler** — `buildErc20Task`, `resolveErc20Token`, `resolveErc20TokensBulk`
- **ERC4626 handler** — `buildErc4626Task`, `resolveErc4626Vault`, `resolveErc4626VaultsBulk`
  - 2-step pipeline: vault metadata + `balanceOf` in step 1 → `convertToAssets(balance)` in step 2
- **Viem engine** — `createViemExecutor`, `createResolver` via `@halaprix/domino/viem`
- **Ethers v6 engine** — `createEthersV6Executor`, `createResolver` via `@halaprix/domino/ethers-v6`
- **Ethers v5 engine** — `createEthersV5Executor`, `createResolver` via `@halaprix/domino/ethers-v5`
- **`MulticallResolver` class** — engine-agnostic application facade; composes any `StepExecutor` with the built-in ERC20/ERC4626 methods plus a generic `run<T>()` extension point
- **`ResolverEngine.run<T>()`** — generic escape hatch for custom `MultistepTask` pipelines beyond ERC20/ERC4626
- Configurable `batchSize` option on `runMultistepTasks` — splits large steps into sequential batches to stay under Multicall3 gas limits (default: 100)
- `batchSize` forwarded through `resolveErc20Bulk` / `resolveErc4626Bulk` and the `MulticallResolver` bulk methods
- Tree-shakeable engine entry points — import one engine, the other two are excluded by the bundler
- `StepResult` and `RawResult` as proper discriminated unions (tagged `status: 'success' | 'failure'`), preventing the logically invalid `{ value, status: 'failure' }` state
- `StepCall.abi` typed as `Abi` from `abitype`, eliminating the `as Abi` cast in the viem engine
- Type-safe accessor helpers in handlers (`asString`, `asBigInt`, etc.) replace `as T` casts
- Routing key constants (`KEYS`) in handlers — typos in key strings are compile errors, not silent routing misses
- `noPropertyAccessFromIndexSignature` added to strict tsconfig
- Type-level tests (`src/__tests__/types.test-d.ts`) verifying discriminated union behaviour, generic inference, and `MulticallResolver` API shape
- Public API exports: `buildErc20Task`, `buildErc4626Task`, `Address`, `BatchOptions`, `MulticallResolver`, `ResolverEngine`
- `prepublishOnly` hook enforces `build + test` before `npm publish`
- `sideEffects: false`, `publishConfig`, `engines: { node: ">=18" }` in `package.json`
- Live benchmark script (`npm run benchmark:live`) — real RPC timing with batch-size sweep and Multicall3 limit probe
- Interactive ERC4626 demo (`docs/index.html`) — no wallet required, uses public RPC
- `docs/api-reference.md` and `docs/benchmarks.md`

### Fixed

- `batchSize: 0` or negative no longer causes an infinite loop — throws `"batchSize must be a positive integer"`.
- Non-integer `batchSize` no longer silently misroutes results via fractional array indices.
- Multicall3 `Call3` tuple field order corrected in the demo (wrong ABI order produced an incorrect function selector).
- `encodeFunctionData` errors in ethers executors are now caught per-call and routed as `{ status: 'failure' }` rather than aborting the entire step batch.
- `position.assets` is `bigint | undefined` — correctly represents the case where `balanceOf` succeeds but `convertToAssets` reverts.
- CI now runs real `tsc --noEmit` (typecheck); build step runs before tests so `dist/` exists for bundle-size checks on a clean checkout.

[1.0.0]: https://github.com/halaprix/domino/releases/tag/v1.0.0
[0.1.0]: https://github.com/halaprix/domino/releases/tag/v0.1.0
