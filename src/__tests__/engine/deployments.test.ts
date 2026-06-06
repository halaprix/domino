import { describe, it, expect } from 'vitest'
import { shouldUseDeployless } from '../../engine/deployments'

describe('shouldUseDeployless', () => {
  it('returns true for unknown chain (any block)', () => {
    expect(shouldUseDeployless(999999, { blockNumber: 1n })).toBe(true)
    expect(shouldUseDeployless(999999, { blockTag: 'latest' })).toBe(true)
  })

  it('returns false for mainnet at latest/safe/finalized', () => {
    expect(shouldUseDeployless(1, { blockTag: 'latest' })).toBe(false)
    expect(shouldUseDeployless(1, { blockTag: 'safe' })).toBe(false)
  })

  it('returns true for mainnet before deployment (14353601)', () => {
    expect(shouldUseDeployless(1, { blockNumber: 5_000_000n })).toBe(true)
    expect(shouldUseDeployless(1, { blockNumber: 14_353_600n })).toBe(true)
  })

  it('returns false for mainnet at/after deployment', () => {
    expect(shouldUseDeployless(1, { blockNumber: 14_353_601n })).toBe(false)
    expect(shouldUseDeployless(1, { blockNumber: 20_000_000n })).toBe(false)
  })

  it('returns false for blockHash (conservative — try deployed first)', () => {
    expect(shouldUseDeployless(1, {
      blockHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    })).toBe(false)
  })
})
