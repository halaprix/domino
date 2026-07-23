# domino spec.md Release Train (1.0.1 → 1.3.0) — Orchestration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. One implementer subagent at a time; controller (Fable) only orchestrates and reviews. Task briefs quote spec.md sections verbatim — spec.md is the normative design doc; this plan is the orchestration layer on top of it.

**Goal:** Implement all four releases of `/home/halaprix/Projects/domino/spec.md` (v5, approved) — 1.0.1 docs truth pass → 1.1.0 foundation → 1.2.0 execution controls → 1.3.0 orchestration — as 22 serial feature PRs on GitHub, each merged after controller review + Codex (gpt-5.6-sol) second opinion.

**Architecture:** spec.md carries the design (error taxonomy, `runSettled`, `defineTask` ref-graph builder, concurrency/bisection/dedup/pinBlock, `MultichainResolver`, handler migration). Current codebase is a clean 1.0.0 baseline with none of it implemented; confirmed bug at `src/core/runMultistepTasks.ts:122` (failure `error` dropped).

**Tech stack:** TypeScript strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), viem (hard dep), vitest, tsup (ESM+CJS single entry), eslint. CI: `.github/workflows/ci.yml` (typecheck → lint → build → test → bundle-size).

## Global Constraints

- **Identity:** ALL commits authored `halaprix <halaprix@users.noreply.github.com>`. **NO AI attribution anywhere** — no `Co-Authored-By: Claude`, no `🤖 Generated with` in commits, PR titles, or PR bodies (explicit user override of harness defaults). `gh auth switch --user halaprix` before any GitHub operation (active account is currently `xyref`).
- **Serial execution:** exactly ONE implementer subagent at a time. Branch per task, PR to `main`, squash-merge after review gates pass.
- **Model policy:** mechanical tasks → `haiku`; design/multi-file/concurrency tasks → `sonnet`; controller reviews everything and never writes implementation code. Always pass `model:` explicitly to the Agent tool.
- **Review gates per PR (in order):** (1) implementer self-review + full local gate `npm run lint && npm run typecheck && npm test` green; (2) controller task review (spec compliance + code quality, against the diff file); (3) Codex second opinion, model **`gpt-5.6-sol`** (verified available: codex-cli 0.145.0; config default is gpt-5.6-terra, so `-m gpt-5.6-sol` / MCP `model` param must be explicit) on the branch diff vs `main`; (4) CI green on the PR. Critical/Important findings → fix subagent → re-review. Then merge.
- **Compatibility policy (spec):** every 1.0 export stays exported and tested through 1.x; new RPC-behavior features are opt-in; compat suite runs in CI from T5 onward.
- **TDD** for every implementer; no `console.log` in production code; ABIs inlined in handler files.
- **Releases:** version bump + CHANGELOG PR per milestone; controller pushes tag `vX.Y.Z` after merge; **GitHub release / npm publish stays manual for the user** (publish.yml fires on release publication — never create a GitHub release).
- **Progress ledger:** `.superpowers/sdd/progress.md` (git-ignored) — one line per completed task with commit range; source of truth for resume after compaction.

---

## Pre-flight (Task 0 — controller, no subagent)

1. `gh auth switch --user halaprix`; verify `gh auth status` and `git config user.name/user.email` (set repo-local to `halaprix` / `halaprix@users.noreply.github.com` if unset).
2. Commit `spec.md` + copy of this plan to the repo (e.g. `docs/plans/2026-07-23-release-train.md`) on `main` — spec is currently untracked and briefs reference it.
3. Create `.superpowers/sdd/progress.md` ledger; ensure `.superpowers/` is git-ignored.
4. Check `gh secret list` for an `RPC_URL` secret (resolves how G1/G2 live tests are gated — see T20/T21).

## Pinned design decisions (resolve spec ambiguities BEFORE dispatch; put in briefs)

These are controller rulings on everything the spec leaves open ("unchanged from v1" references a doc that doesn't exist in the repo):

**P1 — `defineTask` API surface (normative for T8/T9/T12/T19–T21):**

```ts
export function defineTask<S>(build: (t: TaskBuilder) => S): MultistepTask<ResolveRefs<S>>
interface TaskBuilder {
  call<...>(spec: TypedCallSpec<...>): Ref<Return>          // optional: true → Ref<Return | undefined>
  derive<I extends readonly Ref<unknown>[], R>(inputs: I, fn: (...vals) => R): Ref<R>
}
interface TypedCallSpec<abi, fn> {
  target: Address | Ref<Address>
  abi: abi | readonly string[]                              // human-readable accepted (F3)
  functionName: fn                                          // constrained to 'view' | 'pure' items (F1)
  args?: WithRefs<args>                                     // Ref<T> assignable at every position
  optional?: boolean
  dedupe?: boolean                                          // per-call eligibility override, read in 1.2 (T16)
}
```

- `Ref<T>` is opaque (branded). Step depth: `1 + max(depth of Ref inputs in target/args)`; `derive` is step-transparent (depth = max input depth, adds no step). Compiles in a single synchronous pass to a plain `MultistepTask` with internal keys; result typing via abitype `ContractFunctionReturnType`.
- Returned shape: plain objects/arrays traversed recursively; Ref leaves resolve to values. Rejection rule (F5): task rejected only if a failed non-optional ref is reachable from the returned shape.

**P2 — `runSettled` surface:** standalone `runSettled(executor, tasks, options?)` in core mirroring `runMultistepTasks`, PLUS `MulticallResolver.runSettled(tasks, options?)` method. Both exported/typed in T7.

**P3 — human-readable ABI boundary:** public `StepCall.abi` stays `Abi`. Only `TypedCallSpec`/`defineTask`/handler params accept `Abi | readonly string[]`; core normalizes via memoized `parseAbi` (WeakMap + string-key LRU ~256) **before** the `StepExecutor.executeMulticall` boundary. Custom executors keep receiving parsed `Abi` — widening would break them.

**P4 — README hero is two-phase:** 1.0.1 (T2) hero uses the current real API and must compile; T12 rewrites it around `defineTask`. (Spec's "hold for defineTask" condition is satisfied differently under serial orchestration — fixing the fictional hero can't wait.)

**P5 — snippet CI mechanism (T1):** `scripts/check-snippets.ts` extracts ```ts fences from `README.md`, `MIGRATION.md`, `docs/*.md` into scratch files + includes literal `docs/snippets/*.ts`, type-checks all with `tsc --noEmit` against **built dist types** (dedicated `tsconfig.snippets.json` mapping `@halaprix/domino` → `dist/index.d.ts`). Non-compiling illustrative fences use ```text. Badge: drift-check — script gzips `dist/index.js`, compares to README badge value, CI fails on divergence. Anvil execution: NOT in 1.0.1 (optional per spec).

**P6 — bundle budgets:** T8 edits `src/__tests__/bundle-size.test.ts` threshold 35KB → **raw < 40KB** with measured delta recorded in the PR body; "defineTask layer ≤ 3KB gzip" is a one-off measurement in the T8 PR body, not a CI gate.

**P7 — `getBlockNumber` signature (T17/T19):** `getBlockNumber?(block?: BlockParam): Promise<bigint>` on `StepExecutor`; default resolves `latest`; Eip1193Executor implements via `eth_getBlockByNumber(tag).number`. `pinBlock: true` with absent `block` resolves `latest`.

**P8 — ES2022.Error CI assertion (T6):** a type-level test asserting `new Error('x', { cause: e }).cause` type-checks (lives in the existing typecheck step; tsconfig `lib` already `["ES2022"]`).

**P9 — live-test env convention:** `RPC_URL` = mainnet; `RPC_URL_<chainId>` for other chains. Live tests use `describe.runIf(!!process.env.RPC_URL)` (auto-skip locally/CI when absent) + a manual `workflow_dispatch` CI job. **Merge gates stay offline** (fixture parity for G1, typecheck for G2).

**P10 — cross-PR contracts** (pin verbatim in every consuming brief):
- `DominoCallError` / `DominoCallErrorKind` exactly as spec F4's code block + field-usage table (kinds × data/cause).
- `TaskDiagnostics { optionalFailures: Array<{ target?; functionName?; error: DominoCallError }> }`, `SettledTaskResult<T>` — diagnostics always present, never optional.
- `SINGLE_USE = Symbol('domino.singleUse')` brand on defineTask + `buildErc20Task`/`buildErc4626Task` outputs; consumed-state in a core-module `WeakSet` shared by all runners; `DominoTaskReuseError`. User-authored legacy tasks NOT guarded.
- The six-line consumption pipeline (spec F2 [v3/v4]) verbatim: `validateOptions` → `rejectDuplicateInstances` → `validatePinCapability` → `markTasksConsumed` → `await resolvePinnedBlock` → `await executeSteps`; which steps do/don't consume; zero-call runs DO consume. T9 creates the seams (pin slots as no-ops); T17 fills them.
- Final `BatchOptions` + `PinnedBlock` + `Presets.throughput` field set verbatim from the spec 1.2.0 code block (names pinned once in T14's brief even though fields land across T14–T17).
- Dedup key `(target.toLowerCase(), calldata, canonicalOutputSignature)` + the `canon` function verbatim (order-preserving, names included, never sorted).

---

## Task list (22 PRs, serial)

Format: **Tn (model) — branch — spec §** · files · must-pin brief details. Dependencies are strictly sequential unless noted.

### Milestone 1 — v1.0.1

**T1 (sonnet) — `ci/snippet-checks` — D4** · `.github/workflows/ci.yml`, `scripts/check-snippets.ts`, `tsconfig.snippets.json`, `docs/snippets/` seed, `package.json` scripts · Pin: P5 in full; checks run against built dist types; MIGRATION.md included ("migration-guide accuracy is a release gate").

**T2 (haiku) — `docs/readme-truth-pass` — D1** · `README.md`, `docs/snippets/*` · Pin: P4 (current-API hero, compiling); every call includes `target`; `viem/chains` import; remove nonexistent `name` field; honest batch math ("100 vaults + owner @ batchSize 100 = 7 round-trips today"); replace `1.8–2.4KB` badge with CI-measured gzip; state viem is a hard runtime dependency.

**T3 (haiku) — `docs/api-benchmarks-regen` — D2+D3** · `docs/api-reference.md`, `docs/benchmarks.md` · Pin: brief enumerates the exact current `src/index.ts` export list; remove ALL v0.1.0 surface (`createResolver`, subpaths, ethers engines, dual-engine diagram); reuse CLAUDE.md architecture diagram; benchmarks table = round-trips at default batchSize + second column at batchSize ∞; no "1 RPC call" claims; delete stale subpath bundle rows.

**T4 (haiku) — `chore/release-1.0.1` — 1.0.1 acceptance** · `package.json` (1.0.1), `CHANGELOG.md` · Acceptance: all published examples type-check in CI; no doc references a removed export. → controller tags `v1.0.1`.

### Milestone 2 — v1.1.0

**T5 (haiku) — `test/compat-suite` — Compatibility policy** · new `src/__tests__/compat/`, CI job · Pin: representative 1.0-consumer snippets **compiled AND executed** (mock executor) against the build: positional `new MulticallResolver(executor)`, `client:` params, `resolveErc20TokensBulk`/`resolveErc4626VaultsBulk` names, `metadata.maxWithdraw/maxRedeem`, hand-written `MultistepTask`, pre-1.1 `Erc4626VaultResolution` construction. Deliberately BEFORE all 1.1 features so it guards T6–T21.

**T6 (sonnet) — `feat/f4-error-taxonomy` — F4** · new `src/core/errors.ts`, `src/core/runMultistepTasks.ts:122` fix, `src/engine/eip1193.ts` `#decodeResults`, `src/index.ts`, tests, P8 type-test · Pin: full field-usage table (revert→data=returnData; decode→data=bytes AND cause=decode error; batch→cause=transport; skipped→cause=upstream DominoCallError; derive→cause=thrown); `data` never stuffed into `cause`; `super(message, { cause })`; empty-`0x` from code-less address → `kind:'decode'`, `data:'0x'` (distinct from revert); only revert/decode kinds get wired here (batch/skipped/derive consumed by T7/T8/T14+).

**T7 (sonnet) — `feat/f5-run-settled` — F5** · new `src/core/runSettled.ts`, `src/engine/resolver.ts`, `src/index.ts`, tests · Pin: P2, P10 diagnostics contract (always present, both fulfilled and rejected); rejection rule (legacy half only testable now — defineTask half is T8's test, scope it OUT explicitly); pre-1.2 limitation: whole physical batch fails `kind:'batch'` without bisection; `run` keeps exact 1.0 semantics.

**T8 (sonnet) — `feat/f2-define-task` — F2 core + F1** · new `src/core/defineTask.ts` (+`refs.ts`), `src/core/types.ts` (`TypedCallSpec`, `WithRefs`), `src/index.ts`, runtime + `expectTypeOf` type tests, `bundle-size.test.ts` → 40KB (P6) · Pin: P1 in full; single synchronous pass, DAG by construction, topo-depth with step-transparent derive, dynamic `target: Ref<Address>`, compiles to plain MultistepTask, internal keys; derive throw → `kind:'derive'`; skip-chain → `kind:'skipped'` cause=upstream; optional → `Ref<T|undefined>` + error retained in `TaskDiagnostics.optionalFailures` ("demoted, never destroyed"); unused-ref failure doesn't reject (deferred T7 test lands HERE); `functionName` constrained `'view'|'pure'` (normative — dedup safety invariant); plant `dedupeEligible` marker on compiled calls (read in T16). Largest PR of the project.

**T9 (sonnet) — `feat/f2-single-use-guard` — F2 reuse semantics** · `defineTask.ts`, `runMultistepTasks.ts`, `runSettled.ts`, handlers (brand factories), `errors.ts` (`DominoTaskReuseError`), tests · Pin: six-line pipeline verbatim (P10) incl. which failures consume; zero-call runs DO consume; guard ONLY on `SINGLE_USE`-branded tasks (defineTask + built-in factories) — user legacy tasks NOT guarded (v4 WeakSet retracted); runner-level `WeakSet`; creation-site stack capture lazy/dev-only; duplicate-instance-in-one-array → throw without consuming; pin seams created as named no-op slots for T17.

**T10 (haiku) — `feat/f3-human-readable-abi` — F3** · `src/core/abi.ts`, `defineTask.ts`/`types.ts`, tests · Pin: P3 (normalization core-side, executors still get `Abi`); `parseAbi` memoized WeakMap + string-key LRU ~256; abitype inference parity between forms tested.

**T11 (haiku) — `feat/f10-f11-aliases-shapes` — F10+F11** · `resolver.ts`, `handlers/erc20.ts`, `handlers/erc4626.ts`, `src/index.ts`, tests · Pin: `executor:` preferred, `client:` `@deprecated` through 1.x, **passing both throws**; standalone `resolveErc20Bulk`/`resolveErc4626Bulk` canonical, `*TokensBulk`/`*VaultsBulk` = deprecated alias exports (`export const old = new`) forever-in-1.x; `position.maxWithdraw?`/`maxRedeem?` **optional in type, always populated at runtime** (runtime-additive ≠ type-additive); `metadata.*` copies stay required + `@deprecated`, both locations always equal; compat test constructs pre-1.1 shape and must compile; export `makeResolver` (currently defined but unexported) as deprecated + tested.

**T12 (sonnet) — `docs/1.1-refresh` — D1 phase 2 + non-functional** · `README.md` (defineTask hero), `docs/api-reference.md`, `docs/snippets/*`, `MIGRATION.md` · Pin: api-reference presents `defineTask` as recommended path, legacy `MultistepTask` as compilation target; document single-use idiom ("factories return a fresh task"), diagnostics, isolation semantics; all snippets pass T1's CI.

**T13 (haiku) — `chore/release-1.1.0`** · version, CHANGELOG per feature · → tag `v1.1.0`.

### Milestone 3 — v1.2.0

**T14 (sonnet) — `feat/f6-concurrency-pool` — F6a (pool + fail-fast)** · `runMultistepTasks.ts` + new `src/core/pool.ts`, `runSettled.ts`, vitest setup (global `unhandledRejection` guard) + `vitest.config.ts`, tests incl. fuzz · Pin: full `BatchOptions` shape verbatim (P10) — defaults `maxConcurrentBatches: 1`, `adaptiveBatching: false`, `dedupe: false`; validation: batchSize/maxConcurrentBatches/maxBatchAttempts safe integers ≥ 1, throw **before consumption** (T9's `validateOptions` slot); routing index-based, completion-order-independent (fuzz w/ random delays); fail-fast (a)–(d) verbatim: queued not dispatched, in-flight settle with `.catch(noop)`, thrown error = lowest original batch index then lowest call index **among discovered terminal errors**, deterministic ONLY for exactly-one-failing-batch (multi-failure identity explicitly unspecified), in-flight results discarded; `runSettled` never cancels. Acceptance: 600 calls/bs=100/conc=5 ≈ 2 sequential-RT wall-clock (latency-simulated executor); zero unhandled rejections.

**T15 (sonnet) — `feat/f6-adaptive-bisection` — F6b** · same core modules, tests · Pin: split on batch throw with length>1, retry both halves through the pool; length===1 → rethrow (`run`) / record `batch` failure (`runSettled`); default `maxBatchAttempts = 2*ceil(log2(batchSize))+1`, every sub-batch execution counts; exhaustion → `kind:'batch'`, cause=last transport error; retries ONLY transport/batch-level failures — never individual reverts inside successful multicalls; **permit released before children enqueued, coordinated by central per-step queue, never recursively awaited** (test: pool=1, poisoned batch of 100, must terminate); document 2N−1 bound + cap-before-full-isolation → coarse `batch` failures, never wrong data. Acceptance: single-poisoned fixture — error-identity invariant over ≥100 shuffled runs; multi-poisoned — only "some DominoCallError thrown, no unhandled rejections".

**T16 (sonnet) — `feat/f7-dedup-presets` — F7 + Presets** · core pipeline (dedup stage pre-bisection), `types.ts` (`dedupe?` on TypedCallSpec), `Presets` export, `docs/benchmarks.md` hit-rate row, tests · Pin: key + `canon` verbatim (P10 — order-preserving, names included, NEVER sorted); scope = within step across tasks, pre-bisection; fan-out copies success AND failure to all subscribers; `dedupeEligible`: TypedCallSpec→true (override per-call), legacy StepCall→false; `Presets.throughput = { maxConcurrentBatches: 5, adaptiveBatching: true, dedupe: true }`; explicit test: throughput preset can never change legacy-task semantics; test: same calldata + conflicting output ABIs → two wire calls, both decode correctly.

**T17 (sonnet) — `feat/f8-pin-block` — F8** · `types.ts` (P7 `getBlockNumber?`), `eip1193.ts`, core runners (fill T9's pin seams), docs "Atomicity" section, tests · Pin: tags `latest|safe|finalized` resolve ONCE at run start (+1 RT); **`pending`+`pinBlock` → throw**; explicit `blockNumber` → no-op; `blockHash` → no-op, `requireCanonical` untouched, mapped to `{ blockHash, requireCanonical }` (no extra RPC); `onPin` synchronous, once per run, only when `pinBlock: true`, both `run` and `runSettled`; `onPin` throws → run rejects, tasks REMAIN consumed, no batches dispatched; executor without `getBlockNumber` + pinBlock → throw BEFORE consumption.

**T18 (haiku) — `chore/release-1.2.0`** · version, CHANGELOG, default-rationale block recorded in docs · → tag `v1.2.0`.

### Milestone 4 — v1.3.0

**T19 (sonnet) — `feat/f9-multichain` — F9** · new `src/engine/multichain.ts`, `src/index.ts`, tests · Pin: `Record<chainId, provider|executor>` ctor, `chain()`, `snapshot()` (parallel block map via P7), `runAll`/`runAllSettled` with per-chain `blocks` overrides, chains parallel, lazy executor wrapping, single-`T` generic (mixed shapes → per-chain calls, documented); **[v5] duplicate-instance validation over the entire flattened plan BEFORE any chain executes** (same instance under two chain IDs rejected up front — test required); `onPin` per chain in `runAll`.

**T20 (sonnet) — `feat/g1-handler-migration` — G1** · `handlers/erc20.ts`, `handlers/erc4626.ts` reimplemented on `defineTask`, old impls → test-only path (excluded from runtime path + bundle), parity tests, optional live-fork job (P9) · Pin: public `buildErc*Task` signatures never change; parity = `expect(new).toStrictEqual(old)` (bigints, field presence, array order, undefined-present vs absent); failure fixtures: `kind` and `data` match via `toBe`, `cause` chain preserved, messages may differ; NO runtime switch/env flags; old impl retained one minor as parity oracle then deleted; merge gate = offline fixture parity, live fork on-demand.

**T21 (sonnet) — `feat/g2-refinance-example` — G2 (release gate)** · new `examples/refinance.ts`, snippet-CI scope extension, README pointer · Pin: Aave v3 + Spark `getReserveData` bulk; Morpho 2-step IRM rate with dynamic target from `idToMarketParams` (exercises `Ref<Address>` target); `MultichainResolver` variant with pinned per-chain snapshot (P9 env convention); uses `Presets.throughput`; runs against `RPC_URL`; type-check is the merge gate.

**T22 (haiku) — `chore/release-1.3.0`** · version, CHANGELOG, perf-guidance docs · → tag `v1.3.0`.

---

## Per-PR workflow (controller loop)

For each task Tn:
1. Record `BASE=$(git rev-parse main)`. Create branch from fresh `main`.
2. Build the task brief file (scratchpad): verbatim spec section(s) + this plan's pins (P*/contracts) + current-state facts + report-file path. Dispatch implementer (`Agent`, explicit `model:` haiku/sonnet, `run_in_background: false`). Implementer: TDD, `npm run lint && npm run typecheck && npm test` green before every commit, commits authored halaprix, NO AI attribution, returns status (DONE/DONE_WITH_CONCERNS/NEEDS_CONTEXT/BLOCKED).
3. Handle status per subagent-driven-development (context → re-dispatch; too hard → escalate haiku→sonnet; plan wrong → ask user).
4. Generate review package (`git log --oneline BASE..HEAD`, `git diff --stat`, `git diff -U10` → one file). Controller reviews: spec compliance against the brief + code quality. Critical/Important → fix subagent (same model) → re-review.
5. Codex second opinion: `mcp__plugin_second-opinion_codex__codex` (or `codex exec`) with **model `gpt-5.6-sol`**, sandbox read-only, prompt = review the branch diff vs main against the spec section. Adjudicate findings (verify before acting — external reviews can be wrong); real issues → fix subagent → re-review both gates.
6. Push branch, `gh pr create` (halaprix account, no AI attribution, body = summary + spec sections + test evidence). Wait for CI green.
7. Squash-merge via `gh pr merge --squash`, delete branch, pull main.
8. Append ledger line: `Tn: complete (PR #x, commits base7..head7, review clean, codex clean)`.

**Milestone close (T4/T13/T18/T22):** after chore PR merges — `git tag vX.Y.Z && git push origin vX.Y.Z`. STOP: user creates the GitHub release manually (that triggers npm publish).

**Final whole-branch review:** at each milestone close, one broad review (controller, most capable judgment) of the milestone's cumulative diff + Minor-findings triage from the ledger.

## Verification

- Every PR: lint + typecheck + full vitest + bundle-size + (from T1) snippet checks + (from T5) compat suite, all in CI on the PR.
- Spec acceptance criteria are copied into each brief and checked line-by-line at controller review (e.g. F6's wall-clock and shuffled-run invariants, F7's two-wire-calls test, G1's toStrictEqual parity).
- End-to-end: after T21, `examples/refinance.ts` type-checks in CI; with `RPC_URL` set locally, executes live; compat suite still green proves 1.0 consumers unbroken across the whole train.

## Risks / escalation

- **T8 is the hardest PR** (type-level inference + graph compiler). If the implementer stalls, fallback split: runtime builder + basic Ref typing first, inference + type-test suite second.
- Spec conflicts discovered mid-implementation: present finding + spec text to the user (per pre-flight review rule) — never silently deviate from spec.md.
- Haiku implementer BLOCKED twice on the same task → re-dispatch on sonnet, note in ledger.
- Anything touching publish (GitHub release, npm) is user-only. Tag pushes are the workflow's outer limit.
