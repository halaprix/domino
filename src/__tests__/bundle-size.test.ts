/**
 * Bundle size regression tests.
 *
 * v2: Single entry point — Eip1193Executor + handlers + bytecodes + viem ABI utils.
 * viem utils tree-shake to ~3KB; bytecodes add ~8KB; core + handlers ~19KB.
 * Target: under 41KB raw (unminified `dist/index.js` byte length — the
 * README's "gzip" badge tracks the compressed size separately, see
 * `scripts/check-snippets.ts`'s `checkBadge()`).
 *
 * 1.1 (F5): `runSettled` adds ~1KB raw — threshold bumped from 35KB to 36KB.
 *
 * 1.1 (F2, `defineTask`): budget consciously raised to 40KB raw. Measured
 * delta (raw `dist/index.js` byte length via `readFileSync(..., 'utf-8')
 * .length`, same metric this test asserts on):
 *   before: 36,360 bytes (35.51KB)  gzip 8,241 bytes (8.05KB)
 *   after:  40,910 bytes (39.95KB)  gzip 9,745 bytes (9.52KB)
 *   delta:  +4,550 bytes raw (+4.44KB)  +1,504 bytes gzip (+1.47KB)
 * (Includes the controller-review fix that preserves a custom executor's raw
 * error as `cause` on the synthesized batch error — +57 bytes raw over the
 * very first measurement.)
 *
 * 1.1 (F2 hardening round — external review, 6 accepted findings): budget
 * raised again, 40KB → **41KB** raw, controller-pre-authorized. Adds: a
 * per-task ownership token on every `RefHandle` + a build-time check
 * rejecting a ref from a different `defineTask()` call; a `closed` flag
 * rejecting `t.call`/`t.derive` after the builder callback has returned +a
 * thenable check rejecting an async builder; a shallow guard in `resShape`
 * rejecting a `Ref` nested inside a class instance/non-plain object; and
 * type-level tightening (`args` required once a function takes inputs, the
 * non-optional `call` overload pinned to `optional?: false` so a widened
 * `boolean` matches neither overload, `target` accepting `Ref<Address |
 * undefined>`) — the last three are types only, zero runtime bytes. Measured
 * delta for this round:
 *   before: 40,910 bytes (39.95KB)  gzip 9,745 bytes (9.52KB)
 *   after:  41,905 bytes (40.92KB)  gzip 10,076 bytes (9.84KB)
 *   delta:  +995 bytes raw (+0.97KB)  +331 bytes gzip (+0.32KB)
 *
 * `defineTask` + `refs.ts` compile to ~5.4KB raw / ~2.2KB gzip on their own
 * (measured by isolating their banner-commented section of the bundle). The
 * ref graph (nodes/depth/resolution engine) uses single/double-letter
 * internal field and local names (never exposed past `defineTask.ts`'s own
 * closures) specifically to fit this budget — see the "Field names are
 * deliberately terse" comment on `Node` in `src/core/defineTask.ts`.
 *
 * 1.1 (F2 single-use guard, T9): budget raised again, 41KB → **42KB** raw,
 * controller-pre-authorized (≤1KB). Adds `src/core/internal.ts` (the
 * `SINGLE_USE` brand, the shared consumed-tracking `WeakSet`, and the
 * validate → reject-duplicates → pin-capability → mark-consumed →
 * resolve-pinned-block pipeline shared by both runners) and
 * `DominoTaskReuseError`. Same budget pressure as `defineTask.ts` — this
 * module's locals/params are deliberately terse (`t`/`ts`/`o`) for the same
 * reason. Measured delta:
 *   before: 41,905 bytes (40.92KB)  gzip 10,076 bytes (9.84KB)
 *   after:  42,957 bytes (41.95KB)  gzip 10,414 bytes (10.17KB)
 *   delta:  +1,052 bytes raw (+1.03KB)  +338 bytes gzip (+0.33KB)
 *
 * Engine subpaths (viem, ethers-v5, ethers-v6) removed in v2.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const distDir = resolve(import.meta.dirname, '../../dist')

function bundleSize(name: string): number {
  return readFileSync(join(distDir, name), 'utf-8').length
}

describe('bundle size', () => {
  it('main index bundle is under 42KB (core + handlers + viem utils + bytecodes + defineTask + hardening + single-use guard)', () => {
    const size = bundleSize('index.js')
    // v2 bundles viem ABI utils (~3KB) + bytecodes (~8KB) + core/handlers (~19KB);
    // 1.1 (F5) adds runSettled (~1KB); 1.1 (F2) adds defineTask (~4.4KB);
    // 1.1 (F2 hardening round) adds ~1KB more; 1.1 (F2 single-use guard, T9)
    // adds ~1KB more — see the module doc comment above for the full
    // measured delta.
    expect(size).toBeLessThan(42 * 1024)
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
