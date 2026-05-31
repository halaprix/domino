/**
 * Bundle size regression tests.
 * Ensures the main index bundle does NOT grow unbounded and engine splits are respected.
 *
 * After M3: engine re-exports were removed from src/index.ts : the main bundle
 * now contains only the core FSM + handlers (no ethers, no viem).
 * Consumers import engines from subpaths (engines/viem, engines/ethers-v6, etc.).
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const distDir = resolve(import.meta.dirname, '../../dist')

function bundleSize(name: string): number {
  return readFileSync(join(distDir, name), 'utf-8').length
}

describe('bundle size', () => {
  it('main index bundle is under 15KB (engines NOT bundled : use engine subpaths)', () => {
    const size = bundleSize('index.js')
    // Engines are no longer re-exported from root. The main entry contains only
    // runMultistepTasks, types, and handler exports. Should stay small.
    expect(size).toBeLessThan(15 * 1024)
  })

  it('viem engine is the smallest engine (~8KB)', () => {
    const size = bundleSize('engines/viem.js')
    expect(size).toBeLessThan(20 * 1024)
  })

  it('ethers-v6 engine is larger than viem (ethers is a bigger lib)', () => {
    const viemSize = bundleSize('engines/viem.js')
    const ethersV6Size = bundleSize('engines/ethers-v6.js')
    expect(ethersV6Size).toBeGreaterThan(viemSize)
  })

  it('ethers-v5 dist file exists and is non-empty (external, not bundled in main)', () => {
    const size = bundleSize('engines/ethers-v5.js')
    expect(size).toBeGreaterThan(0)
    expect(size).toBeLessThan(30 * 1024)
  })
})
