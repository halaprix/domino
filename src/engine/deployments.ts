import type { BlockParam } from '../core/types'

/**
 * Multicall3 deployment blocks for major EVM chains.
 *
 * Data source: viem chain definitions (contracts.multicall3.blockCreated).
 * Unknown chains: always use deployless (conservative default).
 */
export const MULTICALL3_DEPLOYMENTS: Record<
  number,
  { blockCreated: bigint }
> = {
  1: { blockCreated: 14353601n },      // Ethereum
  42161: { blockCreated: 7654707n },    // Arbitrum One
  8453: { blockCreated: 5022n },       // Base
  10: { blockCreated: 4286263n },       // OP Mainnet
  137: { blockCreated: 25770160n },     // Polygon
  43114: { blockCreated: 11907934n },   // Avalanche
  56: { blockCreated: 15921452n },      // BNB Chain
  100: { blockCreated: 21022491n },     // Gnosis
}

/**
 * Determine whether deployless multicall is needed.
 *
 * Returns true when Multicall3 definitely wasn't deployed yet
 * at the target block. Returns false when it was (or when we
 * can't determine — falls back to deployed multicall).
 */
export function shouldUseDeployless(
  chainId: number,
  block: BlockParam = { blockTag: 'latest' },
): boolean {
  const deployment = MULTICALL3_DEPLOYMENTS[chainId]
  if (!deployment) return true // unknown chain → deployless

  // Block tags: 'latest', 'pending', 'safe', 'finalized' — always post-deployment
  if ('blockTag' in block) return false

  // Block number: compare against deployment
  if ('blockNumber' in block) {
    return block.blockNumber < deployment.blockCreated
  }

  // blockHash: can't determine block number without eth_getBlockByHash.
  // Be conservative: try deployed first, fall back on failure.
  return false
}
