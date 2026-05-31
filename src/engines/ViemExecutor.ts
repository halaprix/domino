/**
 * ViemExecutor — implements StepExecutor via viem's multicall aggregate3.
 * This file exists separately to break circular import cycles with the handlers.
 */

import type { PublicClient } from 'viem'
import type { StepCall, StepExecutor, RawResult } from '../core/types'

export class ViemExecutor implements StepExecutor {
  constructor(private client: PublicClient) {}

  async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
    const contracts = calls.map((call) => ({
      address: call.target,
      abi: call.abi,
      functionName: call.functionName,
      args: call.args ?? ([] as readonly unknown[]),
    }))

    const results = await this.client.multicall({
      contracts,
      allowFailure: true,
    })

    return results.map((result) => {
      if (result.status === 'failure') {
        return { status: 'failure' as const }
      }
      return { status: 'success' as const, value: result.result }
    })
  }
}
