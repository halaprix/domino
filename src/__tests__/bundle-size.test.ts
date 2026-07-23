/**
 * Bundle size regression tests.
 *
 * v2: Single entry point — Eip1193Executor + handlers + bytecodes + viem ABI utils.
 * viem utils tree-shake to ~3KB; bytecodes add ~8KB; core + handlers ~19KB.
 * Target: under 40KB raw (unminified `dist/index.js` byte length — the
 * README's "gzip" badge tracks the compressed size separately, see
 * `scripts/check-snippets.ts`'s `checkBadge()`).
 *
 * 1.1 (F5): `runSettled` adds ~1KB raw — threshold bumped from 35KB to 36KB.
 *
 * 1.1 (F2, `defineTask`): budget consciously raised to 40KB raw. Measured
 * delta (this PR, raw `dist/index.js` byte length via `readFileSync(...,
 * 'utf-8').length`, same metric this test asserts on):
 *   before: 36,360 bytes (35.51KB)  gzip 8,241 bytes (8.05KB)
 *   after:  40,910 bytes (39.95KB)  gzip 9,745 bytes (9.52KB)
 *   delta:  +4,550 bytes raw (+4.44KB)  +1,504 bytes gzip (+1.47KB)
 * (The "after" figures include the controller-review fix that preserves a
 * custom executor's raw error as `cause` on the synthesized batch error —
 * +57 bytes raw over the pre-fix measurement, still under the 40KB ceiling
 * with 50 bytes to spare; see that fix's own note further down this file's
 * history / the task report.)
 * `defineTask` + `refs.ts` compile to ~4.4KB raw / ~1.9KB gzip on their own
 * (measured by isolating their banner-commented section of the bundle) —
 * within the F2 spec's "≤3KB gzip" per-layer budget once the ~0.4KB gzip
 * `runSettled` diagnostics-symbol delta is accounted separately. The ref
 * graph (nodes/depth/resolution engine) uses single/double-letter internal
 * field and local names (never exposed past `defineTask.ts`'s own closures)
 * specifically to fit this budget — see the "Field names are deliberately
 * terse" comment on `Node` in `src/core/defineTask.ts`.
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
  it('main index bundle is under 40KB (core + handlers + viem utils + bytecodes + defineTask)', () => {
    const size = bundleSize('index.js')
    // v2 bundles viem ABI utils (~3KB) + bytecodes (~8KB) + core/handlers (~19KB);
    // 1.1 (F5) adds runSettled (~1KB); 1.1 (F2) adds defineTask (~4.4KB) —
    // see the module doc comment above for the full measured delta.
    expect(size).toBeLessThan(40 * 1024)
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
