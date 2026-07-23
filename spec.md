# domino — Change Spec v5 (FINAL): 1.0.1 → 1.1.0 → 1.2.0 → 1.3.0

Status: v5 — approved for implementation (round-5 go verdict, edits applied). Review loop closed; remaining risk moves to code + tests. Deltas marked **[v2]**/**[v3]**/**[v4]**.
Empirical baseline (informational, not normative — regenerate at release-notes build time, do not hand-maintain): registry.npmjs.org search API, 2026-07-23: weekly 8 / monthly 50 downloads, **0 dependents**, 1.0.0 published 2026-06-06.

---

## Release train **[v2: restructured]**

The project stays on the 1.x line. **No 2.0 release is planned.** With aliases and dual-location fields (below), no user-facing capability requires a breaking release; eventual removals live in the "Future breaking changes" appendix and are gated on adoption data plus a deprecation period.

| Release | Contents | Compatibility |
|---|---|---|
| **1.0.1** | Docs truth pass + snippet CI | no runtime changes |
| **1.1.0** | Foundation: error propagation + taxonomy, `runSettled`, typed `defineTask`, ABI typing, human-readable ABI, `executor:` alias, additive naming/shape fixes | additive; all defaults preserved |
| **1.2.0** | Execution controls: parallel batches, adaptive bisection, dedup, `pinBlock` — **all opt-in** + `Presets.throughput` | additive and opt-in |
| **1.3.0** | `MultichainResolver`, internal handler migration to `defineTask` (parity-gated), `examples/refinance.ts`, perf guidance | additive |
| Future | Possible removals / default flips | not scheduled |

### Compatibility policy **[v2]**

- APIs published in 1.0 remain exported and covered by compatibility tests throughout 1.x. Deprecated APIs disappear from headline docs, not from the package.
- New behaviors affecting RPC concurrency, retry patterns, call counts, or block selection are opt-in.
- Every 1.x release runs a compat suite: representative 1.0-consumer snippets compiled and executed against the new build.
- Rationale note: current usage is ~zero, so this policy costs little today — it is adopted as discipline signaling (semver hygiene is part of the DX pitch), not because migration pressure exists.

---

# 1.0.1 — Docs truth pass

Unchanged from v1. Summary:

**D1 README:** replace fictional generator hero example with a compiling one (prefer holding for `defineTask` if 1.1 ships within ~2 weeks); every call includes `target`; `viem/chains` import; remove nonexistent `name` field from claimed return shape; honest batch math (100 vaults + owner @ batchSize 100 = 7 round-trips today); replace the 1.8–2.4KB badge with CI-measured gzip of `dist/index.js`; state viem is a hard runtime dependency.

**D2 api-reference.md:** regenerate against `src/index.ts`. Remove all v0.1.0 surface (`createResolver`, subpaths, ethers engines, dual-engine diagram). Reuse the correct architecture diagram from CLAUDE.md.

**D3 benchmarks.md:** remove subpath/ethers rows; RPC-count table reports round-trips at default batchSize, second column at batchSize ∞; no footnote-dependent "1 RPC call" claims.

**D4 Snippet CI:** `docs/snippets/*.ts` type-checked (`tsc --noEmit` against built dist types) in CI; badge value CI-generated or drift-checked; optional anvil execution. **[v2]** MIGRATION.md snippets included in the check — migration-guide accuracy is a release gate.

**Acceptance:** all published examples type-check in CI; no doc references a removed export.

---

# 1.1.0 — Foundation

## F4. Error propagation + taxonomy *(implement first — everything else's tests assert on real errors)*

- Fix `runMultistepTasks.ts:122`: `list.push({ status: 'failure', key, error: result.error })`. (`StepResult.error?` already exists — non-breaking.)
- Taxonomy:

```ts
export type DominoCallErrorKind = 'revert' | 'decode' | 'batch' | 'skipped' | 'derive'
export class DominoCallError extends Error {
  readonly kind: DominoCallErrorKind
  readonly data?: `0x${string}`   // [v4] raw bytes — separate field, never stuffed into cause
  readonly target?: Address
  readonly functionName?: string
  readonly key?: string           // legacy tasks
  constructor(message: string, opts: { kind: DominoCallErrorKind; cause?: unknown; data?: `0x${string}`; target?: Address; functionName?: string; key?: string }) {
    super(message, { cause: opts.cause })   // [v2] standard Error cause chain — never discard provider/decode stacks
    // ...
  }
}
```

**[v4] Field usage per kind** (`cause` retains original errors/stacks; `data` carries bytes — decode needs both, one property can't do two jobs):

| kind | `data` | `cause` |
|---|---|---|
| `revert` | returnData (revert selector inspectable) | — |
| `decode` | raw bytes that failed to decode | the decode error |
| `batch` | — | provider/transport error |
| `skipped` | — | upstream `DominoCallError` |
| `derive` | — | thrown value |

- **[v3, v5: wording]** `Error` `cause` requires the tsconfig `lib` to include `ES2022.Error` (directly or via `ES2022`+later — do NOT prescribe an exact `lib` array; that would clobber DOM libs in browser configs) and Node ≥16.9 at runtime — engines (`>=18`) covers runtime; CI asserts `ES2022.Error` availability. If a lower target is ever adopted, declare `cause` explicitly and assign as fallback.
- `Eip1193Executor.#decodeResults` populates per the table above; empty-`0x` from a code-less address distinguishable from revert (`kind: 'decode'`, `data: '0x'`).

**Acceptance [v5: aligned with the field table]:** revert bytes reachable via `error.data`; decode failures preserve both `error.data` (raw bytes) and the decoder exception in `error.cause`; `0x` non-contract → `decode` kind with `data: '0x'`; original stack traces preserved through the `cause` chain.

## F5. `runSettled`

```ts
// [v3] Diagnostics are part of the contract, always present (empty object, never optional):
export interface TaskDiagnostics {
  optionalFailures: Array<{ target?: Address; functionName?: string; error: DominoCallError }>
}
export type SettledTaskResult<T> =
  | { status: 'fulfilled'; value: T; diagnostics: TaskDiagnostics }
  | { status: 'rejected'; error: unknown; diagnostics: TaskDiagnostics }

runSettled<T>(tasks, options?): Promise<SettledTaskResult<T>[]>
```

**Isolation semantics [v2: made exact]:**
- After adaptive isolation (1.2) or plain batch failure, only subscribers of the irrecoverably failed *unique call* receive `failure` StepResults; other calls from the same physical batch complete normally (via bisection when enabled; without it, the whole physical batch's calls fail with `kind: 'batch'` — documented limitation of `dedupe/adaptive` off).
- A task is `rejected` **only** when a failed non-optional ref is *reachable from its returned shape* (defineTask) or its `finalize()` throws (legacy). **Failures in unused refs do not reject the task** — explicit test required.
- `run` keeps exact 1.0 semantics: batch failure throws, finalize throw propagates.

## F1. Typed results from the ABI

Unchanged from v1: legacy `MultistepTask` keeps `unknown`; typing lives in `TypedCallSpec` via `ContractFunctionReturnType`. `WithRefs<T>` makes `Ref<T>` assignable at every arg position. Type-level tests with `expectTypeOf`.

**[v2]** `TypedCallSpec` constrains `functionName` to `'view' | 'pure'` — now normative and documented as the invariant that makes dedup (1.2) result-preserving. Legacy `StepCall` remains unconstrained and makes no dedup-safety claim.

## F2. `defineTask` — ref-graph builder

Core design unchanged from v1 (single synchronous pass; DAG by construction; topo-depth step assignment with step-transparent `derive`; dynamic `target: Ref<Address>`; compiles to plain `MultistepTask`; internal keys; loud failure propagation with `optional: true` as the typed escape hatch `Ref<T | undefined>`).

**[v2] additions:**

- **Reusability:** all `MultistepTask` instances are **single-run** — this is already true of 1.0's handler tasks (mutable `ctx` closures) and is now documented. `defineTask` tasks carry a consumed-guard: second submission to `runMultistepTasks`/`run`/`runSettled` throws `DominoTaskReuseError`. **[v3, v4: consumption point fixed]** Exact semantics — "before first executor call" left zero-call runs (constant-only / derive-only tasks) reusable in violation of the contract. Rule: consume after all synchronous validation, before **any** run-side effect:

```
validateOptions()            // failure does NOT consume
rejectDuplicateInstances()   // same instance twice in one array → throw, does NOT consume
validatePinCapability()      // does NOT consume
markTasksConsumed(tasks)     // ← the line
await resolvePinnedBlock()   // getBlockNumber failure DOES leave tasks consumed (execution began)
await executeSteps()
```

**[v4, v5: scope corrected]** The guard applies **only** to tasks carrying an internal single-use brand (`const SINGLE_USE = Symbol('domino.singleUse')`): tasks from `defineTask` and from Domino's built-in factories (`buildErc20Task`, `buildErc4626Task` — mutable-closure state). **User-authored legacy `MultistepTask` objects are NOT automatically guarded** — auto-guarding them would be a new runtime restriction in a minor and would break legitimately stateless reusable custom tasks, violating the compatibility policy (v4's universal `WeakSet` retracted; it also contradicted the adjacent "legacy is doc-only" sentence). Consumed-state tracking for branded tasks uses a runner-level `WeakSet` (no retention). Creation-site stack capture is lazy/dev-only. The idiom is factories (`morphoRate(id)` returns a fresh task). Legacy hand-written tasks: single-use documented as a recommendation, not enforced.
- **`optional` diagnostics:** an optional failure resolves the ref to `undefined` in the value, but the original `DominoCallError` is retained in `TaskDiagnostics.optionalFailures` (see F5 — present on fulfilled **and** rejected entries). Errors are never silently destroyed, only demoted.
- **Derive exceptions** → ref `failure` with `kind: 'derive'`, `cause` = thrown value.

Reference migration of erc20/erc4626 handlers **moves to 1.3** (parity-gated, see G1). Public `buildErc*Task` signatures never change.

**Acceptance:** as v1 (depth/derive/dynamic-target/skip-chain/optional typing/mixed legacy+defineTask batching) plus: reuse throws; unused-ref failure doesn't reject; optional failure appears in diagnostics.

## F3. Human-readable ABI

Unchanged: `abi: Abi | readonly string[]`, `parseAbi` memoized (WeakMap + string-key LRU ~256), abitype inference parity between forms tested.

## F10. `executor:` alias

`executor:` preferred, `client:` accepted with `@deprecated` JSDoc through all of 1.x; passing both throws.

## F11. Additive naming & shape fixes **[v2: relocated from 2.0]**

- `resolveErc20Bulk` / `resolveErc4626Bulk` exported as canonical standalone names; `resolveErc20TokensBulk` / `resolveErc4626VaultsBulk` remain as deprecated aliases (`export const old = new`) forever-in-1.x.
- `Erc4626VaultResolution.position` gains `maxWithdraw` / `maxRedeem` (correct semantic home — owner-dependent). **[v3]** In the public type they are **optional** (`maxWithdraw?: bigint`) though always populated at runtime — adding required fields would source-break consumers who *construct* the type (mocks, adapters); runtime-additive ≠ type-additive. `metadata.maxWithdraw` / `metadata.maxRedeem` remain required and `@deprecated`. Both locations always equal; compat test constructs the type with pre-1.1 shape and must compile.
- `makeResolver`, `TAddr` generics: unchanged, deprecated, tested.

---

# 1.2.0 — Execution controls (all opt-in)

```ts
interface BatchOptions {
  batchSize?: number              // default 100 (unchanged)
  maxConcurrentBatches?: number   // default 1  [v2: was 5]
  adaptiveBatching?: boolean      // default false [v2: was true]
  // [v3] derived default — 8 was insufficient: isolating 1 bad call in a 100-call
  // batch costs 1 + 2*ceil(log2(100)) = 15 executions (both halves run per level).
  maxBatchAttempts?: number       // default: 2 * ceil(log2(batchSize)) + 1
  dedupe?: boolean                // default false [v2: was true]
  pinBlock?: boolean              // default false (unchanged)
  block?: BlockParam
  // [v5] union, not bigint — a blockHash pin has no number without an extra RPC:
  onPin?: (block: PinnedBlock) => void
}
export type PinnedBlock =
  | { blockNumber: bigint }
  | { blockHash: `0x${string}`; requireCanonical?: boolean }
// [v4] Validation (extends the existing 1.0 batchSize check): batchSize, maxConcurrentBatches,
// maxBatchAttempts must each be safe integers ≥ 1 — anything else throws before consumption.

export const Presets = {
  throughput: { maxConcurrentBatches: 5, adaptiveBatching: true, dedupe: true } as const,
} // usage: resolver.run(tasks, { ...Presets.throughput, pinBlock: true })
```

**[v2] Default rationale (recorded so future flips are informed):**
- Concurrency: 5 concurrent eth_calls can trip provider rate limits and breaks custom executors that assume serial invocation. Opt-in until field data.
- Adaptive: bisection cannot distinguish gas-cap failures from rate-limit (429) failures; under rate limiting, retries amplify load up to 2N−1 calls into a throttled endpoint. Off by default until failure-cause classification exists. Bisection retries **only transport/batch-level failures** — never successful multicalls containing individual reverts (those are already per-call failures via `allowFailure`).
- Dedupe: result-preserving for deterministic view/pure reads (the only kind `TypedCallSpec` admits), but changes executor invocation counts observed by instrumentation, caching, billing, and tests. Opt-in; wording "behaviorally invisible" is retracted.
- **[v4, v5: renamed + softened]** Dedupe eligibility is per-call, not per-run: internal `dedupeEligible: boolean` ("eligible", not "safe" — `view`/`pure` do not guarantee referential transparency; a view fn can return `gasleft()` or otherwise be position-sensitive). `TypedCallSpec` → `true` by default, with per-call override `dedupe?: boolean` for gas/position-sensitive reads under a throughput preset; legacy `StepCall` → `false` (no mutability promise — inside one `aggregate3` a non-view call simulated via `eth_call` can mutate state seen by later calls). `dedupe: true` merges only eligible calls, so `Presets.throughput` can never change legacy-task semantics. Docs state the assumption explicitly: enabling dedup assumes identical eligible calls are referentially transparent.

## F6. Parallel batches + adaptive bisection

- Concurrency-limited pool per step; routing index-based and completion-order-independent (fuzz-tested with random delays).
- Bisection: on batch throw with `length > 1`, split and retry both halves through the pool; at `length === 1` rethrow (`run`) or record `batch` failure (`runSettled`). Bound: total executions per original batch ≤ `maxBatchAttempts` (default above; every sub-batch execution counts, successful or not) — on exhaustion, unresolved calls fail with `kind: 'batch'`, `cause` = last transport error. **[v3]** Document: fully isolating k bad calls can require up to `2N − 1` executions; the cap may intentionally stop before full isolation — under `runSettled` this yields coarse-grained `batch` failures, never wrong data.
- **[v3] No pool deadlock:** a failed batch **releases its concurrency permit before its children are enqueued**; bisection is coordinated by the central per-step queue, never recursively awaited inside a permit-holding worker. (Test: pool of 1, poisoned batch of 100 — must terminate.)
- **Cancellation policy for `run` [v2, v3: determinism fixed]:** fail-fast. On the first irrecoverable batch error: (a) queued batches are not dispatched; (b) in-flight batches are allowed to settle, their rejections attached (`.catch(noop)`) so no unhandled rejections escape; (c) **[v3, v4: scope corrected]** after in-flight batches settle, the thrown error is selected by lowest original batch index, then lowest call index, **among discovered terminal errors**. This is guaranteed deterministic **only when exactly one original batch fails irrecoverably** — with multiple concurrently-failing branches, cancellation can prevent a lower-index branch from ever producing its terminal error, so the discovered set is timing-dependent; error identity is explicitly **unspecified** in that case (ordered failure commitment was considered and rejected — it trades fail-fast for a guarantee `run` doesn't need; exact per-call accounting is `runSettled`'s job, documented as such); (d) results of in-flight batches are discarded. `runSettled` never cancels — it records and continues.

**Acceptance:** 600 calls / bs=100 / conc=5 ≈ 2 sequential-RT wall-clock (latency-simulated executor); poisoned single call isolated by bisection with 99 siblings succeeding; attempts counter respected; zero unhandled rejections under fail-fast (vitest `process.on('unhandledRejection')` guard); **[v3, v4]** thrown-error identity invariant over ≥100 shuffled runs for the **single poisoned batch** fixture; multi-poisoned fixture asserts only that *some* `DominoCallError(kind: 'batch'|...)` is thrown and no unhandled rejections escape; permit-release deadlock test (pool=1).

## F7. Dedup

**[v3]** Key = `(target.toLowerCase(), calldata, canonicalOutputSignature)` — calldata already captures selector+inputs; outputs are the only decode-relevant divergence, so two subscribers declaring different output ABIs for identical calldata are **not** merged (prevents first-decoder-wins corruption). Raw-bytes fan-out (decode per subscriber) was considered and rejected: decoding lives inside `StepExecutor.executeMulticall`, so raw fan-out would push dedup into every executor implementation and custom executors would silently lose it; the extended key keeps dedup in core. **[v4]** `canonicalOutputSignature` = stable, **order-preserving** serialization of the matched ABI item's outputs — output-array order and tuple-component order are semantic and MUST NOT be sorted (sorting would make *distinct* layouts collide → wrongful merge → the exact decode corruption this key prevents). Component `name`s are included: viem decodes named tuples to objects and unnamed to arrays, so names affect decoded shape. Only object-key order of the serialized representation is normalized:

```ts
const canon = (p: AbiParameter): unknown => ({ name: p.name ?? '', type: p.type, components: p.components?.map(canon) })
```

Scope = within step across tasks, pre-bisection; fan-out copies success **and** failure to all subscribers. Counting-executor benchmark row (hit rate) added to docs. Test: two tasks, same calldata, conflicting output ABIs → two wire calls, both decode correctly.

## F8. `pinBlock`

- Optional `StepExecutor.getBlockNumber?(block?)`; `Eip1193Executor` implements. Pinning on an executor without it → throw.
- **Tag semantics [v2: new]:** `latest` | `safe` | `finalized` resolve once at run start (+1 RT) to a concrete `blockNumber` used for all steps. **`pending` + `pinBlock` → throw** (`pending` has no stable number; explicitly unsupported). Explicit `blockNumber` → no-op. `blockHash` → no-op, `requireCanonical` preserved untouched.
- **[v3, v5: blockHash contradiction fixed]** Resolved pinned block exposure: `BatchOptions.onPin?: (block: PinnedBlock) => void`, invoked **synchronously** once per run (per chain in `runAll`), only when `pinBlock: true`, for both `run` and `runSettled`. Mapping: resolved tags → `{ blockNumber }`; explicit `blockNumber` → `{ blockNumber }`; explicit `blockHash` → `{ blockHash, requireCanonical }` (no extra RPC to fetch its number). **[v4]** If `onPin` throws: the run rejects with that error, tasks remain consumed, no multicall batches are dispatched.
- Docs: "Atomicity" section — within-step atomic, cross-step not, unless pinned.

---

# 1.3.0 — Orchestration & migration

## F9. `MultichainResolver`

Unchanged from v1: `Record<chainId, provider|executor>` constructor, `chain()`, `snapshot()` (parallel block map), `runAll` / `runAllSettled` with per-chain `blocks` overrides; chains execute in parallel; lazy executor wrapping; single-`T` generic (mixed shapes → per-chain calls, documented).

**[v5]** Duplicate-instance validation runs over the **entire flattened plan** before any chain begins execution — the same task instance under two chain IDs is rejected up front. Otherwise parallel chains race to consume a shared branded task, leaving one chain mid-run when the other throws. Test required.

## G1. Internal handler migration **[v2: gated]**

Reimplement erc20/erc4626 handlers on `defineTask`, public signatures identical. Gate:
1. Fixture parity: **[v4]** new impl output **deeply structurally equal** to old impl output (`expect(new).toStrictEqual(old)` — bigints, field presence, array order, and undefined-present vs absent all distinguished; `===` was shorthand and wrong for fresh object graphs). Failure fixtures: messages may differ in text, but `kind` and `data` must match (`toBe`), `cause` chain preserved.
2. Live fork test (anvil, mainnet fork) both impls side by side.
3. **[v3]** No runtime switch: `process.env` flags don't belong in a browser-consumable EIP-1193 library, and dual-shipping handlers at 0 dependents is complexity without value. Old implementation is retained in source (test-only import, excluded from the public runtime path and bundle) for one minor as the parity-test oracle, then deleted; rollback path is a patch release from git history.

## G2. `examples/refinance.ts` *(release gate, not an afterthought)*

Aave v3 + Spark `getReserveData` bulk; Morpho 2-step IRM rate with dynamic target from `idToMarketParams`; `MultichainResolver` variant with pinned per-chain snapshot; runs against `RPC_URL` like the live benchmark; uses `Presets.throughput`.

---

# Appendix — Future breaking changes (not scheduled)

Reconsidered only with adoption data, migration tooling, and a deprecation period:
1. Remove `client:`, `makeResolver`, `TAddr` generics, old bulk-name aliases, deprecated `metadata.maxWithdraw/maxRedeem` copies.
2. Default flips: `pinBlock: true`; possibly `Presets.throughput` values as defaults.
3. Possible generator-based `defineTask` variant for data-dependent branching.

---

# Implementation order / dependency graph

```
1.0.1: D1 D2 D3 D4                          (independent, ship first)
1.1:   F4 → F5 → F2(+F1) ; F3, F10, F11 independent
1.2:   F6(+cancellation, maxBatchAttempts) ; F7 ; F8   (all depend on F4/F5)
1.3:   F9 (uses F8 snapshot) ; G1 (needs F2) ; G2 (needs everything)
```

Non-functional: bundle budget raised consciously to raw < 40KB in the F2 PR with measured delta noted; `defineTask` layer ≤ 3KB gzip; CHANGELOG per feature; api-reference presents `defineTask` as the recommended path, legacy `MultistepTask` as the compilation target.
