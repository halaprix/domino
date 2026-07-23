/**
 * Bundle size regression tests.
 *
 * v2+: Gzip-only budget. Single entry point — Eip1193Executor + handlers +
 * bytecodes + viem ABI utils. Target: under 15KB gzip (what consumers feel).
 * Both this test and `scripts/check-snippets.ts`'s `checkBadge()` independently
 * measure gzip compression of dist/index.js; this test enforces the ceiling,
 * checkBadge() enforces badge accuracy (±0.1KB).
 *
 * **Historical context (raw-byte budgets, now retired):**
 *
 * v2: Single entry point — Eip1193Executor + handlers + bytecodes + viem ABI utils.
 * viem utils tree-shake to ~3KB; bytecodes add ~8KB; core + handlers ~19KB.
 * Target: under 41KB raw (unminified `dist/index.js` byte length).
 *
 * 1.1 (F5): `runSettled` adds ~1KB raw — threshold bumped from 35KB to 36KB.
 *
 * 1.1 (F2, `defineTask`): budget consciously raised to 40KB raw. Measured
 * delta (raw `dist/index.js` byte length via `readFileSync(..., 'utf-8')
 * .length`):
 *   before: 36,360 bytes (35.51KB)  gzip 8,241 bytes (8.05KB)
 *   after:  40,910 bytes (39.95KB)  gzip 9,745 bytes (9.52KB)
 *   delta:  +4,550 bytes raw (+4.44KB)  +1,504 bytes gzip (+1.47KB)
 * (Includes the controller-review fix that preserves a custom executor's raw
 * error as `cause` on the synthesized batch error — +57 bytes raw over the
 * very first measurement.)
 *
 * 1.1 (F2 hardening round — external review, 6 accepted findings): budget
 * raised again, 40KB → **41KB** raw. Adds: a per-task ownership token on
 * every `RefHandle` + a build-time check rejecting a ref from a different
 * `defineTask()` call; a `closed` flag rejecting `t.call`/`t.derive` after
 * the builder callback has returned + a thenable check rejecting an async
 * builder; a shallow guard in `resShape` rejecting a `Ref` nested inside a
 * class instance/non-plain object; and type-level tightening (`args` required
 * once a function takes inputs, the non-optional `call` overload pinned to
 * `optional?: false` so a widened `boolean` matches neither overload, `target`
 * accepting `Ref<Address | undefined>`) — the last three are types only, zero
 * runtime bytes. Measured delta for this round:
 *   before: 40,910 bytes (39.95KB)  gzip 9,745 bytes (9.52KB)
 *   after:  41,905 bytes (40.92KB)  gzip 10,076 bytes (9.84KB)
 *   delta:  +995 bytes raw (+0.97KB)  +331 bytes gzip (+0.32KB)
 *
 * `defineTask` + `refs.ts` compile to ~5.4KB raw / ~2.2KB gzip on their own
 * (measured by isolating their banner-commented section of the bundle). The
 * ref graph (nodes/depth/resolution engine) used single/double-letter
 * internal field and local names (never exposed past `defineTask.ts`'s own
 * closures) to fit the raw-byte budget; see the "Field names are
 * deliberately terse" comment on `Node` in `src/core/defineTask.ts`.
 *
 * 1.1 (F2 single-use guard, T9): budget raised again, 41KB → **43KB** raw.
 * Adds `src/core/internal.ts` (the `SINGLE_USE` brand, the shared
 * consumed-tracking `WeakSet`, and the validate → reject-duplicates →
 * pin-capability → mark-consumed → resolve-pinned-block pipeline shared by
 * both runners) and `DominoTaskReuseError`. Locals/params in
 * `src/core/internal.ts` were deliberately terse (`t`/`ts`/`o`) — same
 * budget-driven tradeoff as `defineTask.ts` — but the two
 * `DominoTaskReuseError` messages themselves are intentionally NOT
 * shortened: readable diagnostics (what was reused, and the fix — create a
 * fresh task per run/entry, factories return a fresh instance) outrank the
 * raw byte count here; the gzip badge is the number that actually matters
 * to consumers, and it moved by well under 1KB. Measured delta (includes the
 * subsequent external-review round below — P1's per-runner array snapshot
 * and P2's O(n) `rejectDuplicateInstances` rewrite net out to only a few
 * dozen bytes either way):
 *   before: 41,905 bytes (40.92KB)  gzip 10,076 bytes (9.84KB)
 *   after:  43,268 bytes (42.25KB)  gzip 10,502 bytes (10.26KB)
 *   delta:  +1,363 bytes raw (+1.33KB)  +426 bytes gzip (+0.42KB)
 *
 * 1.1 (F3 human-readable ABI, T10 + P1 external review): budget raised again,
 * 43KB → **45.5KB** raw. Feature adds `parseAbiMemoized()` in `src/core/abi.ts`
 * (WeakMap identity cache + string-key LRU cache, capacity 256) for
 * deduplicating parsed ABIs across both array-identity and value-equality
 * boundaries. Integrates `NormalizedAbi<abi>` type helper into
 * `TaskBuilder.call` overloads and `TypedCallSpec` to accept both `Abi` and
 * `readonly string[]` forms at build time, normalizing to parsed `Abi` at
 * runtime before storing on the node. P1 external review adds:
 * (P1.1) identity-cache stores { abi, key } and refreshes LRU recency on hits
 * to prevent reference-equality splits; (P1.2) strict validation loop (per-
 * element check) rejects mixed arrays (strings + objects) at build time. The
 * validation loop in P1.2 is runtime code (must check all elements) and
 * necessary for correctness. Measured delta (F3 base + P1 validation):
 *   before: 43,268 bytes (42.25KB)  gzip 10,502 bytes (10.26KB)
 *   F3 only: 44,115 bytes (43.08KB)  gzip 10,761 bytes (10.51KB)  [+847 raw, +259 gzip]
 *   F3+P1: 44,974 bytes (43.92KB)  gzip 10,916 bytes (10.7KB)  [+1,706 raw, +414 gzip]
 *
 * 1.1 (F2 single-use guard, T9 — external review round): two P2/P1 fixes on
 * top of the above, same 43KB ceiling (net bundle effect negligible):
 * (P1) both `runMultistepTasks` and `runSettled` now snapshot their `tasks`
 * argument (`const ts = tasks.slice()`) BEFORE `prepareRun` runs, and read
 * only that snapshot from then on — closes a TOCTOU window where a caller
 * mutating its own `tasks` array during the `await resolvePinnedBlock()` gap
 * could substitute an unconsumed task in for one already marked consumed.
 * (P2) `rejectDuplicateInstances` rewritten from an O(n²) `indexOf` scan to
 * a single O(n) pass with a lazily-allocated `Set` (only allocated once a
 * branded task is actually seen) — bulk resolvers can submit fully-branded
 * arrays, where the old scan was a real cost at scale (10k entries ≈ 50M
 * comparisons).
 *
 * Engine subpaths (viem, ethers-v5, ethers-v6) removed in v2.
 *
 * 1.3 (F9 `MultichainResolver`): ceiling raised, 15KB → **18KB** gzip.
 * `MultichainResolver` (`src/engine/multichain.ts`) is a legitimate new
 * feature class — parallel per-chain fan-out over the existing single-chain
 * runners, a constructor discriminating/lazily-wrapping `StepExecutor` vs.
 * `Eip1193Provider` entries, and the [v5] flattened cross-chain duplicate-
 * instance guard — not bloat to trim. This test measures the WHOLE bundled
 * artifact, but `"sideEffects": false` (package.json) lets a tree-shaking
 * consumer's bundler drop `MultichainResolver` entirely if unused, so the
 * ceiling here is a whole-library budget, not a per-consumer cost — a
 * consumer who never imports it pays nothing for it. 18KB (not the ~16.7KB
 * this feature alone needs) deliberately leaves ~1.3KB of headroom for the
 * remaining 1.3 work (G1's handler migration is expected to be roughly
 * size-neutral: old handler implementations leave the bundle as new ones
 * enter). Measured delta:
 *   before: 56,205 bytes (54.89KB)  gzip 14,282 bytes (13.95KB)
 *   after:  65,226 bytes (63.70KB)  gzip 17,065 bytes (16.67KB)
 *   delta:  +9,021 bytes raw (+8.81KB)  +2,783 bytes gzip (+2.72KB)
 *
 * 1.3 (F9 external-review round — 2 accepted findings, same 18KB ceiling):
 * (P1) `snapshot()`'s `getBlockNumber()` calls are now wrapped in
 * `Promise.resolve().then(...)` — a non-conforming custom executor that
 * throws SYNCHRONOUSLY (instead of rejecting a promise) used to abort the
 * `.map()` mid-iteration, discarding an earlier chain's already-created
 * promise with no handler ever attached to it (a real, reproduced
 * unhandled-rejection leak, not hypothetical). (P2) the flattened
 * cross-chain duplicate scan (`assertNoFlattenedDuplicates`) now calls a
 * shared `isSingleUseTask()` predicate (`src/core/internal.ts`) instead of
 * re-implementing the brand check inline — `rejectDuplicateInstances`/
 * `markTasksConsumed` now call the same predicate too, replacing the inline
 * `Branded<T>`-cast pattern those two used before. Measured delta:
 *   before: 65,226 bytes (63.70KB)  gzip 17,065 bytes (16.67KB)
 *   after:  66,345 bytes (64.79KB)  gzip 17,533 bytes (17.12KB)
 *   delta:  +1,119 bytes raw (+1.09KB)  +468 bytes gzip (+0.46KB)
 *
 * 1.3 (G1 handler migration): `buildErc20Task`/`buildErc4626Task` reimplemented
 * on `defineTask` (public signatures unchanged — see
 * `src/__tests__/parity-g1.test.ts`). NET DECREASE, not neutral: the
 * hand-written per-field `consumeStepResults`/`finalize` routing the two
 * handlers used to carry is now expressed as `t.call`/`t.derive` composition
 * over the already-bundled `defineTask` engine, so the marginal cost of each
 * handler shrinks to its ABI arrays + four tiny coercion helpers. Measured
 * delta:
 *   before: 66,345 bytes (64.79KB)  gzip 17,533 bytes (17.12KB)
 *   after:  64,510 bytes (63.00KB)  gzip 17,185 bytes (16.79KB)
 *   delta:  -1,835 bytes raw (-1.79KB)  -348 bytes gzip (-0.34KB)
 *
 * 1.3 (G1 external-review round, P1 — `resolveAll` v-undefined skip-chain):
 * closes a gap where a "successful"-but-malformed executor value (e.g.
 * `balanceOf` resolving to a non-bigint) demoted to `undefined` by a
 * handler's own coercion derive could still reach a DEPENDENT call's own
 * argument encoding undetected. `src/core/defineTask.ts`'s call-mode
 * `resolveAll` now treats a `'v'`-with-`undefined`-value position the same
 * as a `'u'`/`'f'` one (synthesizing a "argument resolved to undefined"
 * cause); `erc4626`'s `convertToAssets` now takes the COERCED `balance` ref,
 * not the raw call ref. Small net increase (new branch + doc comments +
 * three new core tests do not ship, but the branch itself and the coercion
 * re-route do). Measured delta:
 *   before: 64,510 bytes (63.00KB)  gzip 17,185 bytes (16.79KB)
 *   after:  64,678 bytes (63.16KB)  gzip 17,234 bytes (16.83KB)
 *   delta:  +168 bytes raw (+0.16KB)  +49 bytes gzip (+0.04KB)
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join, resolve } from 'node:path'

const distDir = resolve(import.meta.dirname, '../../dist')

function bundleSize(name: string): number {
  return readFileSync(join(distDir, name), 'utf-8').length
}

function bundleSizeGzip(name: string): number {
  const content = readFileSync(join(distDir, name), 'utf-8')
  return gzipSync(content).length
}

describe('bundle size', () => {
  it('main index bundle is under 18KB gzip (gzip-only budget for consumer experience)', () => {
    const sizeGzip = bundleSizeGzip('index.js')
    // Budget switched to gzip-only: what consumers actually download (transfer size).
    // All features included: viem ABI utils + bytecodes + core/handlers +
    // defineTask + hardening + single-use guard + F3 human-readable ABI +
    // P1 review fixes + F9 MultichainResolver. Gzip is the metric that
    // matters; descriptive naming in production code no longer constrained
    // by raw-byte budget. Ceiling raised 15KB -> 18KB for F9 — see the
    // module doc comment's "1.3 (F9 MultichainResolver)" entry for the
    // measured delta and why 18KB (not just-enough) was chosen.
    expect(sizeGzip).toBeLessThan(18 * 1024)
  })

  it('no engine subpaths exist (removed in v2)', () => {
    expect(() => bundleSize('engines/viem.js')).toThrow()
    expect(() => bundleSize('engines/ethers-v6.js')).toThrow()
    expect(() => bundleSize('engines/ethers-v5.js')).toThrow()
  })

  it('viem is imported as external (not bundled)', () => {
    const src = readFileSync(join(distDir, 'index.js'), 'utf-8')
    // viem/utils should be imported, not inlined
    expect(src).toMatch(/from ['"]viem\/utils['"]/)
  })
})
