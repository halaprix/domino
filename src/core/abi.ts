/**
 * ABI encoding/decoding utilities re-exported from viem/utils.
 *
 * These are the ONLY viem imports domino needs at runtime.
 * All are tree-shakeable (~3KB gzipped total).
 *
 * We intentionally do NOT re-export PublicClient, Transport,
 * or any networking layer — the executor uses a raw EIP-1193
 * provider, and the caller wraps any provider in Eip1193Provider.
 */

import type { Abi } from 'abitype'
import { parseAbi as parseAbiViem } from 'viem'

export {
  encodeFunctionData,
  decodeFunctionResult,
  encodeAbiParameters,
  decodeAbiParameters,
  encodeDeployData,
} from 'viem/utils'

export { parseAbi } from 'viem'

/**
 * Memoized parseAbi with two-layer caching:
 * 1. WeakMap on array identity (same reference → instant hit)
 * 2. String-key LRU (capacity 256) for value-equal arrays with different identities
 *
 * Both layers store the SAME parsed Abi object, ensuring reference equality
 * for deduplication (F1.2) across different forms.
 *
 * @internal Do NOT export from src/index.ts — for domino internal use only.
 */
export function parseAbiMemoized(fragments: readonly string[]): Abi {
  // Fast path: identity cache hit
  const cached = identityCache.get(fragments)
  if (cached !== undefined) return cached

  // Check value equality in LRU cache
  const key = fragments.join('\n')
  const lruHit = lruCache.get(key)
  if (lruHit !== undefined) {
    // Move to front (mark as recently used)
    lruCache.delete(key)
    lruCache.set(key, lruHit)
    // Also cache by identity for next time
    identityCache.set(fragments, lruHit)
    return lruHit
  }

  // Cache miss: parse and store in both caches
  const parsed = parseAbiViem(fragments)

  // Store in identity cache
  identityCache.set(fragments, parsed)

  // Store in LRU cache
  lruCache.set(key, parsed)

  // Evict oldest if over capacity
  if (lruCache.size > 256) {
    const firstKey = lruCache.keys().next().value as string | undefined
    if (firstKey !== undefined) {
      lruCache.delete(firstKey)
    }
  }

  return parsed
}

/** WeakMap cache: array identity → parsed Abi. */
const identityCache = new WeakMap<readonly string[], Abi>()

/** String-key LRU cache: fragments.join('\n') → parsed Abi. Capacity 256. */
const lruCache = new Map<string, Abi>()
