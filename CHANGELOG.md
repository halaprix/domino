# Changelog

All notable changes to this project will be documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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

[Unreleased]: https://github.com/halaprix/domino/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/halaprix/domino/releases/tag/v0.1.0
