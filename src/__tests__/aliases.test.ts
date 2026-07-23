import { describe, it, expect, vi } from 'vitest'
import {
  resolveErc20Token,
  resolveErc20TokensBulk,
  resolveErc20Bulk,
  resolveErc4626Vault,
  resolveErc4626VaultsBulk,
  resolveErc4626Bulk,
  makeResolver,
} from '../index'
import type { StepExecutor, RawResult, Address } from '../core/types'

/**
 * F10 + F11 tests for executor: alias, deprecated bulk names, and position.maxWithdraw/maxRedeem.
 * - Tests for `executor:` form acceptance
 * - Tests for `client:` form continued acceptance
 * - Tests for both-present error
 * - Tests for neither-present error
 * - Tests for alias identity (resolveErc20TokensBulk === resolveErc20Bulk)
 * - Tests for position optional fields
 * - Tests for makeResolver export
 */

function mockExecutor(results: RawResult[][]): StepExecutor {
  const fn = vi.fn()
  for (const batch of results) {
    fn.mockResolvedValueOnce(batch)
  }
  return { executeMulticall: fn }
}

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4' as Address
const owner = '0x1234567890123456789012345678901234567890' as Address
const vault = '0x7f39c5812d3f46fCEa82257f5aE43fF59E7E9F8a' as Address

describe('F10: executor: alias + F11: bulk renames', () => {
  describe('resolveErc20Token with executor: form', () => {
    it('accepts executor: param and resolves', async () => {
      const executor = mockExecutor([
        [
          { status: 'success', value: 'USDC' },
          { status: 'success', value: 6n },
        ],
      ])

      const result = await resolveErc20Token({
        executor,
        token: USDC,
      })

      expect(result.symbol).toBe('USDC')
      expect(result.decimals).toBe(6)
    })

    it('accepts executor: with owner', async () => {
      const executor = mockExecutor([
        [
          { status: 'success', value: 'USDC' },
          { status: 'success', value: 6n },
          { status: 'success', value: 1000000n },
        ],
      ])

      const result = await resolveErc20Token({
        executor,
        token: USDC,
        owner,
      })

      expect(result.balance).toBe(1000000n)
    })
  })

  describe('resolveErc20Token with client: form (deprecated)', () => {
    it('accepts client: param (deprecated) and resolves identically', async () => {
      const executor = mockExecutor([
        [
          { status: 'success', value: 'USDC' },
          { status: 'success', value: 6n },
        ],
      ])

      const result = await resolveErc20Token({
        client: executor,
        token: USDC,
      })

      expect(result.symbol).toBe('USDC')
      expect(result.decimals).toBe(6)
    })

    it('accepts client: with owner (deprecated)', async () => {
      const executor = mockExecutor([
        [
          { status: 'success', value: 'USDC' },
          { status: 'success', value: 6n },
          { status: 'success', value: 1000000n },
        ],
      ])

      const result = await resolveErc20Token({
        client: executor,
        token: USDC,
        owner,
      })

      expect(result.balance).toBe(1000000n)
    })
  })

  describe('resolveErc20Token with both executor/client', () => {
    it('throws when both executor: and client: are provided', async () => {
      const executor = mockExecutor([])

      await expect(
        resolveErc20Token({
          executor,
          client: executor,
          token: USDC,
        } as any),
      ).rejects.toThrow(
        "Pass either 'executor' or 'client', not both — they are aliases ('client' is deprecated)",
      )
    })
  })

  describe('resolveErc20TokensBulk (canonical)', () => {
    it('accepts executor: param', async () => {
      const executor = mockExecutor([
        [
          { status: 'success', value: 'USDC' },
          { status: 'success', value: 6n },
          { status: 'success', value: 1000000n },
        ],
      ])

      const results = await resolveErc20TokensBulk({
        executor,
        entries: [{ token: USDC, owner }],
      })

      expect(results).toHaveLength(1)
      expect(results[0]?.symbol).toBe('USDC')
    })

    it('accepts client: param (deprecated)', async () => {
      const executor = mockExecutor([
        [
          { status: 'success', value: 'USDC' },
          { status: 'success', value: 6n },
          { status: 'success', value: 1000000n },
        ],
      ])

      const results = await resolveErc20TokensBulk({
        client: executor,
        entries: [{ token: USDC, owner }],
      })

      expect(results).toHaveLength(1)
      expect(results[0]?.symbol).toBe('USDC')
    })

    it('throws when both executor and client provided', async () => {
      const executor = mockExecutor([])

      await expect(
        resolveErc20TokensBulk({
          executor,
          client: executor,
          entries: [{ token: USDC }],
        } as any),
      ).rejects.toThrow(
        "Pass either 'executor' or 'client', not both — they are aliases ('client' is deprecated)",
      )
    })
  })

  describe('resolveErc20Bulk (canonical name)', () => {
    it('is the canonical function', async () => {
      const executor = mockExecutor([
        [
          { status: 'success', value: 'USDC' },
          { status: 'success', value: 6n },
          { status: 'success', value: 1000000n },
        ],
      ])

      const results = await resolveErc20Bulk({
        executor,
        entries: [{ token: USDC, owner }],
      })

      expect(results).toHaveLength(1)
      expect(results[0]?.symbol).toBe('USDC')
    })
  })

  describe('Alias identity: resolveErc20TokensBulk === resolveErc20Bulk', () => {
    it('resolveErc20TokensBulk is the same function as resolveErc20Bulk (deprecated alias)', () => {
      expect(resolveErc20TokensBulk).toBe(resolveErc20Bulk)
    })
  })

  describe('resolveErc20Bulk with empty entries + both/neither (P1 fix)', () => {
    it('throws with both executor and client even on empty entries', async () => {
      const executor = mockExecutor([])

      await expect(
        resolveErc20Bulk({
          executor,
          client: executor,
          entries: [],
        } as any),
      ).rejects.toThrow(
        "Pass either 'executor' or 'client', not both — they are aliases ('client' is deprecated)",
      )
    })

    it('throws with neither executor nor client on empty entries', async () => {
      await expect(
        resolveErc20Bulk({
          entries: [],
        } as any),
      ).rejects.toThrow("Missing 'executor' or 'client' parameter")
    })
  })

  describe('resolveErc4626Vault with executor: form', () => {
    it('accepts executor: param and resolves', async () => {
      const executor = mockExecutor([
        [
          { status: 'success', value: 'wstETH' },
          { status: 'success', value: 18n },
          { status: 'success', value: '0xae7ab96520de3a18e5e111b5eaab095312d7fe84' },
        ],
      ])

      const result = await resolveErc4626Vault({
        executor,
        vault,
      })

      expect(result.metadata.symbol).toBe('wstETH')
    })

    it('accepts executor: with owner and position.maxWithdraw/maxRedeem', async () => {
      const executor = mockExecutor([
        [
          { status: 'success', value: 'wstETH' },
          { status: 'success', value: 18n },
          { status: 'success', value: '0xae7ab96520de3a18e5e111b5eaab095312d7fe84' },
          { status: 'success', value: 500000000000000000n },
          { status: 'success', value: 1000000000000000000n },
          { status: 'success', value: 1000000000000000000n },
        ],
        [
          { status: 'success', value: 501234567890123456n },
        ],
      ])

      const result = await resolveErc4626Vault({
        executor,
        vault,
        owner,
      })

      expect(result.metadata.symbol).toBe('wstETH')
      expect(result.metadata.maxWithdraw).toBe(1000000000000000000n)
      expect(result.metadata.maxRedeem).toBe(1000000000000000000n)
      expect(result.position?.balance).toBe(500000000000000000n)
      expect(result.position?.maxWithdraw).toBe(1000000000000000000n)
      expect(result.position?.maxRedeem).toBe(1000000000000000000n)
    })
  })

  describe('resolveErc4626Vault with client: form (deprecated)', () => {
    it('accepts client: param (deprecated) and resolves identically', async () => {
      const executor = mockExecutor([
        [
          { status: 'success', value: 'wstETH' },
          { status: 'success', value: 18n },
          { status: 'success', value: '0xae7ab96520de3a18e5e111b5eaab095312d7fe84' },
        ],
      ])

      const result = await resolveErc4626Vault({
        client: executor,
        vault,
      })

      expect(result.metadata.symbol).toBe('wstETH')
    })
  })

  describe('resolveErc4626VaultsBulk (canonical)', () => {
    it('accepts executor: param', async () => {
      const executor = mockExecutor([
        [
          { status: 'success', value: 'wstETH' },
          { status: 'success', value: 18n },
          { status: 'success', value: '0xae7ab96520de3a18e5e111b5eaab095312d7fe84' },
          { status: 'success', value: 1n },
          { status: 'success', value: 1n },
          { status: 'success', value: 1n },
        ],
        [
          { status: 'success', value: 2n },
        ],
      ])

      const results = await resolveErc4626VaultsBulk({
        executor,
        entries: [{ vault, owner }],
      })

      expect(results).toHaveLength(1)
      expect(results[0]?.metadata.symbol).toBe('wstETH')
    })

    it('accepts client: param (deprecated)', async () => {
      const executor = mockExecutor([
        [
          { status: 'success', value: 'wstETH' },
          { status: 'success', value: 18n },
          { status: 'success', value: '0xae7ab96520de3a18e5e111b5eaab095312d7fe84' },
          { status: 'success', value: 1n },
          { status: 'success', value: 1n },
          { status: 'success', value: 1n },
        ],
        [
          { status: 'success', value: 2n },
        ],
      ])

      const results = await resolveErc4626VaultsBulk({
        client: executor,
        entries: [{ vault, owner }],
      })

      expect(results).toHaveLength(1)
      expect(results[0]?.metadata.symbol).toBe('wstETH')
    })

    it('throws when both executor and client provided', async () => {
      const executor = mockExecutor([])

      await expect(
        resolveErc4626VaultsBulk({
          executor,
          client: executor,
          entries: [{ vault }],
        } as any),
      ).rejects.toThrow(
        "Pass either 'executor' or 'client', not both — they are aliases ('client' is deprecated)",
      )
    })
  })

  describe('resolveErc4626Bulk (canonical name)', () => {
    it('is the canonical function', async () => {
      const executor = mockExecutor([
        [
          { status: 'success', value: 'wstETH' },
          { status: 'success', value: 18n },
          { status: 'success', value: '0xae7ab96520de3a18e5e111b5eaab095312d7fe84' },
          { status: 'success', value: 1n },
          { status: 'success', value: 1n },
          { status: 'success', value: 1n },
        ],
        [
          { status: 'success', value: 2n },
        ],
      ])

      const results = await resolveErc4626Bulk({
        executor,
        entries: [{ vault, owner }],
      })

      expect(results).toHaveLength(1)
      expect(results[0]?.metadata.symbol).toBe('wstETH')
    })
  })

  describe('Alias identity: resolveErc4626VaultsBulk === resolveErc4626Bulk', () => {
    it('resolveErc4626VaultsBulk is the same function as resolveErc4626Bulk (deprecated alias)', () => {
      expect(resolveErc4626VaultsBulk).toBe(resolveErc4626Bulk)
    })
  })

  describe('resolveErc4626Bulk with empty entries + both/neither (P1 fix)', () => {
    it('throws with both executor and client even on empty entries', async () => {
      const executor = mockExecutor([])

      await expect(
        resolveErc4626Bulk({
          executor,
          client: executor,
          entries: [],
        } as any),
      ).rejects.toThrow(
        "Pass either 'executor' or 'client', not both — they are aliases ('client' is deprecated)",
      )
    })

    it('throws with neither executor nor client on empty entries', async () => {
      await expect(
        resolveErc4626Bulk({
          entries: [],
        } as any),
      ).rejects.toThrow("Missing 'executor' or 'client' parameter")
    })
  })

  describe('position.maxWithdraw/maxRedeem optional fields', () => {
    it('position includes maxWithdraw/maxRedeem when calls succeed', async () => {
      const executor = mockExecutor([
        [
          { status: 'success', value: 'wstETH' },
          { status: 'success', value: 18n },
          { status: 'success', value: '0xae7ab96520de3a18e5e111b5eaab095312d7fe84' },
          { status: 'success', value: 500000000000000000n },
          { status: 'success', value: 1000000000000000000n },
          { status: 'success', value: 1000000000000000000n },
        ],
        [
          { status: 'success', value: 501234567890123456n },
        ],
      ])

      const result = await resolveErc4626Vault({
        executor,
        vault,
        owner,
      })

      expect(result.position).toBeDefined()
      expect('maxWithdraw' in result.position!).toBe(true)
      expect('maxRedeem' in result.position!).toBe(true)
      expect(result.position?.maxWithdraw).toBe(1000000000000000000n)
      expect(result.position?.maxRedeem).toBe(1000000000000000000n)
    })

    it('position omits maxWithdraw/maxRedeem keys when calls fail (exactOptionalPropertyTypes)', async () => {
      const executor = mockExecutor([
        [
          { status: 'success', value: 'wstETH' },
          { status: 'success', value: 18n },
          { status: 'success', value: '0xae7ab96520de3a18e5e111b5eaab095312d7fe84' },
          { status: 'success', value: 500000000000000000n },
          { status: 'failure' }, // maxWithdraw fails
          { status: 'failure' }, // maxRedeem fails
        ],
        [
          { status: 'success', value: 501234567890123456n },
        ],
      ])

      const result = await resolveErc4626Vault({
        executor,
        vault,
        owner,
      })

      expect(result.position).toBeDefined()
      expect('maxWithdraw' in result.position!).toBe(false)
      expect('maxRedeem' in result.position!).toBe(false)
      // metadata fields still present but undefined
      expect(result.metadata.maxWithdraw).toBeUndefined()
      expect(result.metadata.maxRedeem).toBeUndefined()
    })

    it('position fields equal metadata fields when both present', async () => {
      const executor = mockExecutor([
        [
          { status: 'success', value: 'wstETH' },
          { status: 'success', value: 18n },
          { status: 'success', value: '0xae7ab96520de3a18e5e111b5eaab095312d7fe84' },
          { status: 'success', value: 500000000000000000n },
          { status: 'success', value: 1234567890123456789n },
          { status: 'success', value: 9876543210987654321n },
        ],
        [
          { status: 'success', value: 501234567890123456n },
        ],
      ])

      const result = await resolveErc4626Vault({
        executor,
        vault,
        owner,
      })

      expect(result.position?.maxWithdraw).toBe(result.metadata.maxWithdraw)
      expect(result.position?.maxRedeem).toBe(result.metadata.maxRedeem)
    })
  })

  describe('makeResolver export', () => {
    it('makeResolver returns a working resolver', async () => {
      const executor = mockExecutor([
        [
          { status: 'success', value: 'USDC' },
          { status: 'success', value: 6n },
        ],
      ])

      const resolver = makeResolver(executor)

      const result = await resolver.resolveErc20({
        token: USDC,
      })

      expect(result.symbol).toBe('USDC')
      expect(result.decimals).toBe(6)
    })

    it('makeResolver is a function that creates a MulticallResolver', () => {
      const executor = mockExecutor([])

      const resolver = makeResolver(executor)

      expect(typeof resolver).toBe('object')
      expect(typeof resolver.resolveErc20).toBe('function')
      expect(typeof resolver.resolveErc20Bulk).toBe('function')
      expect(typeof resolver.resolveErc4626).toBe('function')
      expect(typeof resolver.resolveErc4626Bulk).toBe('function')
    })
  })
})
