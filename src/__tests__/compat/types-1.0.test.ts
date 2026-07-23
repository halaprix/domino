import { describe, it, expect } from 'vitest'
import type {
  StepCall,
  StepExecutor,
  RawResult,
  Eip1193Provider,
  Address,
  Erc20TokenResolution,
  Erc4626VaultResolution,
  MultistepTask,
} from '../../index'

/**
 * 1.0-consumer compat — do not modernize these tests; they must keep passing on every 1.x release.
 *
 * Pattern: type-shape construction (compile-time)
 * - Construct pre-1.1 shapes as VALUES with explicit type annotations
 * - Verify shapes remain assignable (runtime enforcement via expect)
 * - Test that maxWithdraw / maxRedeem remain in metadata (deprecated in 1.1, removed in 2.0)
 * - Use constructed values so lint doesn't flag them as unused
 */

describe('Type shapes 1.0 — compile-time compat', () => {
  it('constructs Erc20TokenResolution shape without owner', () => {
    const res: Erc20TokenResolution = {
      symbol: 'USDC',
      decimals: 6,
      balance: undefined,
    }

    expect(res.symbol).toBe('USDC')
    expect(res.decimals).toBe(6)
    expect(res.balance).toBeUndefined()
  })

  it('constructs Erc20TokenResolution shape with balance', () => {
    const res: Erc20TokenResolution = {
      symbol: 'WETH',
      decimals: 18,
      balance: 1000000000000000000n,
    }

    expect(res.symbol).toBe('WETH')
    expect(res.decimals).toBe(18)
    expect(res.balance).toBe(1000000000000000000n)
  })

  it('constructs Erc4626VaultResolution shape with position', () => {
    const res: Erc4626VaultResolution = {
      metadata: {
        symbol: 'wstETH',
        decimals: 18,
        underlyingAsset: '0xae7ab96520de3a18e5e111b5eaab095312d7fe84' as Address,
        maxWithdraw: 1000000000000000000n,
        maxRedeem: 1000000000000000000n,
      },
      position: {
        balance: 500000000000000000n,
        assets: 501234567890123456n,
      },
    }

    // Verify all fields are accessible and typed
    expect(res.metadata.symbol).toBe('wstETH')
    expect(res.metadata.maxWithdraw).toBe(1000000000000000000n)
    expect(res.metadata.maxRedeem).toBe(1000000000000000000n)
    expect(res.position?.balance).toBe(500000000000000000n)
    expect(res.position?.assets).toBe(501234567890123456n)
  })

  it('constructs Erc4626VaultResolution shape without position', () => {
    const res: Erc4626VaultResolution = {
      metadata: {
        symbol: 'wstETH',
        decimals: 18,
        underlyingAsset: '0xae7ab96520de3a18e5e111b5eaab095312d7fe84' as Address,
        maxWithdraw: undefined,
        maxRedeem: undefined,
      },
      position: undefined,
    }

    expect(res.metadata.symbol).toBe('wstETH')
    expect(res.metadata.maxWithdraw).toBeUndefined()
    expect(res.position).toBeUndefined()
  })

  it('constructs StepCall literal', () => {
    const call: StepCall = {
      key: 'symbol',
      target: '0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4' as Address,
      abi: [],
      functionName: 'symbol',
    }

    expect(call.key).toBe('symbol')
    expect(call.target).toBe('0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4')
    expect(call.functionName).toBe('symbol')
  })

  it('constructs StepCall with args', () => {
    const owner = '0x1234567890123456789012345678901234567890' as Address
    const call: StepCall = {
      key: 'balance',
      target: '0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4' as Address,
      abi: [],
      functionName: 'balanceOf',
      args: [owner],
    }

    expect(call.key).toBe('balance')
    expect(call.args).toEqual([owner])
  })

  it('constructs RawResult success', () => {
    const result: RawResult = {
      status: 'success',
      value: 'USDC',
    }

    expect(result.status).toBe('success')
    expect((result as any).value).toBe('USDC')
  })

  it('constructs RawResult failure', () => {
    const result: RawResult = {
      status: 'failure',
    }

    expect(result.status).toBe('failure')
    expect((result as any).value).toBeUndefined()
  })

  it('constructs RawResult failure with error', () => {
    const result: RawResult = {
      status: 'failure',
      error: 'call reverted',
    }

    expect(result.status).toBe('failure')
    expect((result as any).error).toBe('call reverted')
  })

  it('constructs Eip1193Provider object', () => {
    const provider: Eip1193Provider = {
      request: async (args: { method: string; params?: readonly unknown[] }) => {
        if (args.method === 'eth_call') {
          return '0x0000000000000000000000000000000000000000000000000000000000000006'
        }
        throw new Error('unsupported method')
      },
    }

    expect(provider.request).toBeDefined()
    expect(typeof provider.request).toBe('function')
  })

  it('constructs StepExecutor object', () => {
    const executor: StepExecutor = {
      async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
        return calls.map(() => ({
          status: 'success' as const,
          value: 'test',
        }))
      },
    }

    expect(executor.executeMulticall).toBeDefined()
    expect(typeof executor.executeMulticall).toBe('function')
  })

  it('constructs MultistepTask object', () => {
    const task: MultistepTask<{ result: string }> = {
      maxStep: 1,
      buildStepCalls(step) {
        if (step !== 1) return []
        return [
          {
            key: 'symbol',
            target: '0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4' as Address,
            abi: [],
            functionName: 'symbol',
          },
        ]
      },
      consumeStepResults() {},
      finalize() {
        return { result: 'ok' }
      },
    }

    expect(task.maxStep).toBe(1)
    expect(typeof task.buildStepCalls).toBe('function')
    expect(typeof task.consumeStepResults).toBe('function')
    expect(typeof task.finalize).toBe('function')
  })
})
