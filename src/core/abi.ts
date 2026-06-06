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

export {
  encodeFunctionData,
  decodeFunctionResult,
  encodeAbiParameters,
  decodeAbiParameters,
  encodeDeployData,
} from 'viem/utils'

export { parseAbi } from 'viem'
