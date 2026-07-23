# Changelog

All notable changes to this project will be documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.2.0] — 2026-07-23

### Added
- `maxConcurrentBatches` (default 1): within-step concurrency pool for physical batch dispatch; completion-order-independent result routing; fail-fast cancellation for `run` (queued batches undispatched, in-flight settle, deterministic error selection); `runSettled` never cancels queued batches.
- `adaptiveBatching` (default false): bisection of transport-failed batches through the central queue, bounded by `maxBatchAttempts` (default `2·⌈log₂(batchSize)⌉+1`, every execution counts; exhaustion → coarse `kind: 'batch'` failures with `cause` = last transport error, never wrong data); deadlock-free by construction; reverts never retried.
- `dedupe` (default false): within-step cross-task merge of eligible calls keyed on `(target, calldata, canonical output signature)` with selector-resolved overloads; fan-out of success and failure to all subscribers; only `TypedCallSpec` calls eligible (legacy tasks never affected).
- `Presets.throughput = { maxConcurrentBatches: 5, adaptiveBatching: true, dedupe: true }` — ready-made preset for portfolio/index workloads.
- `pinBlock` (default false) + `onPin(pinnedBlock)` + `PinnedBlock` type + optional `StepExecutor.getBlockNumber` (Eip1193Executor implements): resolve one concrete block at run start (+1 RT) and reuse for every step; pending unsupported; explicit blockNumber/blockHash are no-ops; onPin fires exactly once per run.

### Changed
- Bundle budget is gzip-only (<15KB); current 13.9 KB gzip.
- Internal: `run`/`runSettled` unified onto one step engine + pool (no observable change at defaults; defaults byte-compatible with 1.1 — pinned by the compat suite).

## [1.1.0] — 2026-07-23

### Added
- `defineTask` — ref-graph task builder with `t.call`/`t.derive`, opaque `Ref<T>`s, topo-depth step assignment with step-transparent derives, dynamic `target: Ref<Address>`, optional field demotion with diagnostics, and skip-chain failure propagation; compiles to a plain `MultistepTask` and batches with legacy tasks.
- Typed call specs — return/args inference from the ABI via viem/abitype; `functionName` constrained to `view`/`pure`; `WithRefs` and `ResolveRefs` utilities.
- Human-readable ABI — `abi: readonly string[]` accepted by `defineTask`, memoized `parseAbi` (identity + LRU-256 layers, reference-stable results); executors always receive parsed `Abi`.
- `runSettled` and `MulticallResolver.runSettled` — per-task settlement with always-present `TaskDiagnostics`; batch failures isolate to the failed physical batch (`DominoCallError` kind `batch`) and execution continues.
- `DominoCallError` taxonomy — kinds `revert`/`decode`/`batch`/`skipped`/`derive` with `data` (raw bytes) and `cause` (original error) as separate fields; failure `StepResult`s now carry the error (1.0 dropped it); empty-`0x` from code-less addresses distinguishable from reverts.
- `executor:` parameter on standalone resolve functions — `client:` remains a `@deprecated` alias through 1.x; passing both throws.
- Canonical `resolveErc20Bulk`/`resolveErc4626Bulk` names; `position.maxWithdraw?`/`maxRedeem?` on `Erc4626VaultResolution` (optional in type, populated when the calls succeed); `makeResolver` exported (`@deprecated`).
- `DominoTaskReuseError` and single-use guard — domino-built task instances (defineTask, buildErc20Task, buildErc4626Task) enforced single-run.
- 1.0-consumer compatibility suite executed against both src and built dist in CI.

### Changed
- Domino-built task instances now throw `DominoTaskReuseError` on reuse (reuse was silently unsound in 1.0 due to mutable closure state). Source-compatible otherwise; see MIGRATION.md.
- Bundle: 7.4KB → 10.9KB gzip (defineTask layer +1.5KB gzip; raw threshold consciously moved per spec).

### Deprecated
- `client:` param (use `executor:`); `resolveErc20TokensBulk`/`resolveErc4626VaultsBulk` (use canonical names); `metadata.maxWithdraw`/`maxRedeem` (use `position.*`). All remain functional through 1.x.

## [1.0.1] — 2026-07-23

### Added
- Snippet CI: every TypeScript fence in README/MIGRATION/docs plus `docs/snippets/*.ts` is type-checked in CI against the built dist types (`npm run check:snippets`); intentionally non-compiling old-API examples carry an audited `<!-- snippet: skip -->` marker; bundle-size badge is drift-checked against the measured gzip of `dist/index.js`.

### Fixed
- README: fictional generator hero replaced with a compiling two-step `MultistepTask` example; nonexistent `name` field removed from documented return shapes; honest batch math (100 vaults + owner @ batchSize 100 = 7 round-trips); viem documented as a hard runtime dependency; bundle badge corrected to measured 7.4KB gzip.
- `docs/api-reference.md`: regenerated against the real 1.0 API surface — removed `createResolver`, subpath imports, ethers engines, and the dual-engine diagram.
- `docs/benchmarks.md`: honest RPC round-trip table (default batchSize and batchSize ∞ columns); removed "1 RPC call" claims and stale subpath bundle rows.
- MIGRATION.md: "After" example now compiles (`mainnet` imported from `viem/chains`).

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

[1.2.0]: https://github.com/halaprix/domino/releases/tag/v1.2.0
[1.1.0]: https://github.com/halaprix/domino/releases/tag/v1.1.0
[1.0.1]: https://github.com/halaprix/domino/releases/tag/v1.0.1
[1.0.0]: https://github.com/halaprix/domino/releases/tag/v1.0.0
[0.1.0]: https://github.com/halaprix/domino/releases/tag/v0.1.0
