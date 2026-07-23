/**
 * Bundle size regression tests.
 *
 * v2: Single entry point — Eip1193Executor + handlers + bytecodes + viem ABI utils.
 * viem utils tree-shake to ~3KB; bytecodes add ~8KB; core + handlers ~19KB.
 * Target: under 36KB raw (unminified `dist/index.js` byte length — the
 * README's "gzip" badge tracks the compressed size separately, see
 * `scripts/check-snippets.ts`'s `checkBadge()`).
 *
 * 1.1 (F5): `runSettled` adds ~1KB raw — threshold bumped from 35KB to 36KB.
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
  it('main index bundle is under 36KB (core + handlers + viem utils + bytecodes)', () => {
    const size = bundleSize('index.js')
    // v2 bundles viem ABI utils (~3KB) + bytecodes (~8KB) + core/handlers (~19KB);
    // 1.1 (F5) adds runSettled (~1KB).
    expect(size).toBeLessThan(36 * 1024)
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
