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
  it('main index bundle is under 15KB gzip (gzip-only budget for consumer experience)', () => {
    const sizeGzip = bundleSizeGzip('index.js')
    // Budget switched to gzip-only: what consumers actually download (transfer size).
    // All features included: viem ABI utils + bytecodes + core/handlers +
    // defineTask + hardening + single-use guard + F3 human-readable ABI +
    // P1 review fixes. Gzip is the metric that matters; descriptive naming
    // in production code no longer constrained by raw-byte budget.
    expect(sizeGzip).toBeLessThan(15 * 1024)
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
