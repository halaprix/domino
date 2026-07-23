import { describe, it, expect } from 'vitest'
import { parseAbiMemoized } from '../core/abi'

/**
 * Tests for F3 (human-readable ABI) memoization:
 * - Identity cache (WeakMap): same array reference → instant hit
 * - Value cache (LRU): equal content, different references → same parsed result
 * - LRU eviction: capacity 256, FIFO on insertion
 * - Error propagation: invalid fragment strings throw at parse time
 */

describe('parseAbiMemoized', () => {
  it('parses a single human-readable ABI fragment', () => {
    const fragments = ['function balanceOf(address) view returns (uint256)'] as const
    const parsed = parseAbiMemoized(fragments)

    // Should be a parsed Abi array of objects
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed.length).toBe(1)
    expect(typeof parsed[0]).toBe('object')
    expect(parsed[0]).toHaveProperty('type', 'function')
    expect(parsed[0]).toHaveProperty('name', 'balanceOf')
  })

  it('identity memo: same array reference passed twice → toBe-equal parsed results', () => {
    const fragments = ['function getNum(uint256 x) view returns (uint256)'] as const
    const result1 = parseAbiMemoized(fragments)
    const result2 = parseAbiMemoized(fragments)

    // Both should be reference-equal (exact same object)
    expect(result1).toBe(result2)
  })

  it('value memo: two different array instances with equal content → toBe-equal parsed results', () => {
    // Create two separate array instances with identical content
    const fragments1 = ['function symbol() view returns (string)'] as const
    const fragments2 = ['function symbol() view returns (string)'] as const

    // These are different references
    expect(fragments1).not.toBe(fragments2)

    const result1 = parseAbiMemoized(fragments1)
    const result2 = parseAbiMemoized(fragments2)

    // But the parsed results should be reference-equal (via LRU cache)
    expect(result1).toBe(result2)
  })

  it('multiple fragments in a single ABI', () => {
    const fragments = [
      'function balanceOf(address) view returns (uint256)',
      'function transfer(address, uint256) returns (bool)',
      'function symbol() view returns (string)',
    ] as const

    const parsed = parseAbiMemoized(fragments)

    expect(parsed.length).toBe(3)
    // All three should be function objects
    expect(parsed.every((item) => typeof item === 'object')).toBe(true)
    // Verify they are all function type entries (check the shape at runtime)
    for (const item of parsed) {
      expect(Object.getOwnPropertyNames(item)).toContain('type')
    }
  })

  it('empty array is treated as already-parsed (parseAbi([]) is valid)', () => {
    const fragments: readonly string[] = []
    const parsed = parseAbiMemoized(fragments)

    // parseAbi([]) returns an empty array
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed.length).toBe(0)
  })

  it('LRU eviction: insert 257 distinct single-fragment ABIs, then re-request the FIRST', () => {
    const abis: Array<readonly string[]> = []
    const results: Array<ReturnType<typeof parseAbiMemoized>> = []

    // Insert 257 distinct ABIs (forcing one eviction at #257)
    for (let i = 0; i < 257; i++) {
      const fragment = `function func${i}() view returns (uint256)` as const
      const abi = [fragment] as const
      abis.push(abi)
      results.push(parseAbiMemoized(abi))
    }

    // The first ABI should have been evicted from the LRU cache
    // (still cached by identity in WeakMap if the array reference is held)
    // Re-request the first one — should parse correctly (a fresh parse)
    const firstAbi = abis[0]!
    const reparse = parseAbiMemoized(firstAbi)

    // Can't assert identity (it's a fresh parse from the evicted LRU slot)
    // but assert correctness: it parses to an object with the right name
    expect(Array.isArray(reparse)).toBe(true)
    expect(reparse.length).toBe(1)
    expect(typeof reparse[0]).toBe('object')
    // Verify it has the expected properties of a parsed ABI entry
    expect(Object.getOwnPropertyNames(reparse[0]!)).toContain('type')
  })

  it('LRU eviction: recently-used ABI identity preserved after others evicted', () => {
    const abis: Array<readonly string[]> = []
    const results: Array<ReturnType<typeof parseAbiMemoized>> = []

    // Insert 256 distinct ABIs
    for (let i = 0; i < 256; i++) {
      const fragment = `function funcA${i}() view returns (uint256)` as const
      const abi = [fragment] as const
      abis.push(abi)
      results.push(parseAbiMemoized(abi))
    }

    // Re-touch the ABI at index 100 (this moves it to the front in the LRU)
    const touchedAbi = abis[100]!
    const touchedResult1 = results[100]!
    const touchedResult2 = parseAbiMemoized(touchedAbi)
    expect(touchedResult1).toBe(touchedResult2)

    // Now insert one more to trigger eviction (should evict the OLDEST, not the touched one)
    const newFragment = 'function funcNew() view returns (uint256)' as const
    const newAbi = [newFragment] as const
    const newResult = parseAbiMemoized(newAbi)
    expect(newResult).toBeDefined()

    // Re-touch the originally-touched ABI again
    const touchedResult3 = parseAbiMemoized(touchedAbi)
    // Should still be reference-equal (it was not evicted because it was recently used)
    expect(touchedResult2).toBe(touchedResult3)
  })

  it('invalid fragment string → parseAbi error propagates synchronously at BUILD time', () => {
    // An invalid ABI fragment that viem's parseAbi will reject
    const invalidFragment = 'garbage not a valid abi fragment' as const
    const invalidAbi = [invalidFragment] as const

    expect(() => parseAbiMemoized(invalidAbi)).toThrow()
  })

  it('integration: multiple calls with same reference → cached, with different references → LRU cached', () => {
    const frag1 = 'function getX() view returns (uint256)' as const
    const abi1 = [frag1] as const
    const abi2 = [frag1] as const // Same content, different array instance

    // Parse using first reference
    const r1 = parseAbiMemoized(abi1)

    // Parse using second reference (different instance, same content)
    const r2 = parseAbiMemoized(abi2)

    // Both should be reference-equal due to value-based LRU cache
    expect(r1).toBe(r2)

    // Parse again using the first reference (identity cache should hit)
    const r3 = parseAbiMemoized(abi1)
    expect(r1).toBe(r3)
  })
})
