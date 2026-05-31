/**
 * Bundle size regression tests.
 * Ensures the main index bundle does NOT grow unbounded and engine splits are respected.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const distDir = resolve(import.meta.dirname, '../../dist')

function bundleSize(name: string): number {
  return readFileSync(join(distDir, name), 'utf-8').length
}

describe('bundle size', () => {
  it('main index bundle is under 800KB (ethers v6 IS bundled — use engines/viem for lean path)', () => {
    const size = bundleSize('index.js')
    // ethers v6 (~750KB) is bundled into the main entry because it's re-exported
    // from src/index.ts. The lean path is 'multistep-multicall/engines/viem' (~8 KB).
    // viem (~55KB) is also bundled. This test is a regression guard; a future
    // ethers bump could push this past 800KB.
    expect(size).toBeLessThan(800 * 1024)
  })

  it('viem engine is the smallest engine (~8KB)', () => {
    const size = bundleSize('engines/viem.js')
    // Viem executor: minimal wrapper, should be tiny
    expect(size).toBeLessThan(20 * 1024)
  })

  it('ethers-v6 engine is larger than viem (ethers is a bigger lib)', () => {
    const viemSize = bundleSize('engines/viem.js')
    const ethersV6Size = bundleSize('engines/ethers-v6.js')
    expect(ethersV6Size).toBeGreaterThan(viemSize)
  })

  it('ethers-v5 dist file exists and is non-empty (external, not bundled)', () => {
    // ethers-v5 is marked external in tsup config — it must exist as a separate file
    const size = bundleSize('engines/ethers-v5.js')
    expect(size).toBeGreaterThan(0)
    // ethers-v5 lib itself is ~900KB; the wrapper should be < 30KB
    expect(size).toBeLessThan(30 * 1024)
  })
})
