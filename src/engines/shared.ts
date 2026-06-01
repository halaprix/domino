/**
 * Shared engine infrastructure — encoding, decoding, and Multicall3 plumbing.
 *
 * This module is pure infrastructure: no handler imports, no domain knowledge.
 * It is used by the ethers v5/v6 engines only (viem uses client.multicall directly).
 *
 * Application-layer resolver logic lives in engines/resolver.ts.
 */

import type { StepCall, StepExecutor, RawResult } from '../core/types'

/** Minimal structural view of an ethers Interface (v5 or v6). */
export interface EncodingInterface {
  encodeFunctionData(functionName: string, args: readonly unknown[]): string
  decodeFunctionResult(
    functionName: string,
    data: string,
  ): { readonly length: number; readonly [index: number]: unknown }
}

/** Minimal structural view of a Multicall3 contract's `aggregate3`. */
export interface Aggregate3Contract {
  aggregate3(
    calls: { target: string; allowFailure: boolean; callData: string }[],
  ): Promise<Array<{ success: boolean; returnData: string }>>
}

/**
 * Executor shared by the ethers v5 and v6 engines: encode each call with the
 * given Interface, batch through Multicall3.aggregate3, then decode each result.
 * `normalize` lets v5 convert BigNumber → bigint; v6 passes values through.
 */
export function createEncodedExecutor(
  mc3: Aggregate3Contract,
  iface: EncodingInterface,
  normalize: (value: unknown) => unknown = (v) => v,
): StepExecutor {
  return {
    async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
      const encoded = calls.map((call) => {
        let callData = '0x'
        try {
          callData = iface.encodeFunctionData(call.functionName, call.args ?? [])
        } catch {
          // If a custom task provides bad args, fail gracefully by sending 0x
          // which will revert on-chain and route back as a per-call failure.
        }
        return {
          target: call.target,
          allowFailure: true,
          callData,
        }
      })

      const results = await mc3.aggregate3(encoded)

      return results.map((r, i) => {
        if (!r.success) return { status: 'failure' as const }
        const call = calls[i]
        if (!call) return { status: 'failure' as const }
        try {
          const decoded = iface.decodeFunctionResult(call.functionName, r.returnData)
          const value = normalize(decoded.length === 1 ? decoded[0] : decoded)
          return { status: 'success' as const, value }
        } catch {
          return { status: 'failure' as const }
        }
      })
    },
  }
}
