import {
  encodeFunctionData,
  decodeFunctionResult,
  encodeDeployData,
  parseAbi,
} from '../core/abi'
import type { StepExecutor, StepCall, RawResult, BlockParam, Eip1193Provider } from '../core/types'
import {
  MULTICALL3_BYTECODE,
  DEPLOYLESS_WRAPPER_BYTECODE,
  MULTICALL3_ADDRESS,
} from './bytecodes'
import { shouldUseDeployless } from './deployments'

// ─── Multicall3 ABI (just what we need) ───────────────────────────────

const multicall3Abi = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calldata calls) payable returns (Result[] memory)',
] as const)

// ─── Executor ─────────────────────────────────────────────────────────

export class Eip1193Executor implements StepExecutor {
  #provider: Eip1193Provider
  #chainId: number | null = null
  #chainIdPromise: Promise<number> | null = null

  constructor(provider: Eip1193Provider) {
    this.#provider = provider
  }

  /**
   * Detect chainId from the provider.
   * Uses a promise-based lock to prevent concurrent eth_chainId calls.
   */
  async #detectChainId(): Promise<number> {
    if (this.#chainId !== null) return this.#chainId
    if (this.#chainIdPromise) return this.#chainIdPromise

    this.#chainIdPromise = this.#provider
      .request({ method: 'eth_chainId' })
      .then((result) => {
        this.#chainId = Number(BigInt(result as string))
        return this.#chainId
      })
      .finally(() => {
        this.#chainIdPromise = null
      })

    return this.#chainIdPromise
  }

  /**
   * Force re-detection of chainId (e.g., after wallet chain switch).
   */
  async refreshChainId(): Promise<number> {
    this.#chainId = null
    return this.#detectChainId()
  }

  /**
   * Execute one batch of calls.
   */
  async executeMulticall(
    calls: StepCall[],
    block: BlockParam = { blockTag: 'latest' },
  ): Promise<RawResult[]> {
    if (calls.length === 0) return []

    const chainId = await this.#detectChainId()

    // Build block param for eth_call (EIP-1898 format)
    const blockParam = this.#toBlockParam(block)

    if (shouldUseDeployless(chainId, block)) {
      return this.#executeDeployless(calls, blockParam)
    }

    // Try deployed multicall first; fall back to deployless on
    // "contract not deployed" errors (empty code at address).
    try {
      return await this.#executeDeployed(calls, blockParam)
    } catch (err) {
      // Only fall back on contract-not-found errors.
      // Network errors, rate limits, 401s should propagate.
      if (this.#isContractNotFoundError(err)) {
        return this.#executeDeployless(calls, blockParam)
      }
      throw err
    }
  }

  // ─── Error detection ─────────────────────────────────────────────

  /**
   * Detect whether an error indicates the Multicall3 contract
   * doesn't exist at the target block (empty code / not deployed).
   *
   * Matches viem's ContractFunctionExecutionError and the
   * raw RPC error when eth_call targets a non-contract address.
   */
  #isContractNotFoundError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false
    const msg = (err as Error).message ?? String(err)
    const lower = msg.toLowerCase()
    return (
      lower.includes('contract not found') ||
      lower.includes('no contract at') ||
      lower.includes('empty account') ||
      lower.includes('returned no data') ||
      lower.includes('execution reverted') ||
      lower.includes('invalid address')
    )
  }

  #toBlockParam(block: BlockParam): string | Record<string, unknown> {
    if ('blockNumber' in block) {
      return `0x${block.blockNumber.toString(16)}`
    }
    if ('blockTag' in block) {
      return block.blockTag
    }
    // blockHash with optional requireCanonical (EIP-1898)
    return {
      blockHash: (block as { blockHash: string }).blockHash,
      ...((block as { requireCanonical?: boolean }).requireCanonical !== undefined
        ? { requireCanonical: (block as { requireCanonical?: boolean }).requireCanonical }
        : {}),
    }
  }

  // ─── Deployed multicall ──────────────────────────────────────────

  async #executeDeployed(
    calls: StepCall[],
    blockParam: string | Record<string, unknown>,
  ): Promise<RawResult[]> {
    const call3s = calls.map((call) => ({
      target: call.target,
      allowFailure: true,
      callData: encodeFunctionData({
        abi: call.abi,
        functionName: call.functionName,
        args: call.args as any,
      }),
    }))

    const data = encodeFunctionData({
      abi: multicall3Abi,
      functionName: 'aggregate3',
      args: [call3s],
    })

    const result = await this.#provider.request({
      method: 'eth_call',
      params: [{ to: MULTICALL3_ADDRESS, data }, blockParam],
    })

    return this.#decodeResults(result as `0x${string}`, calls)
  }

  // ─── Deployless multicall (CREATE-style via wrapper) ─────────────

  async #executeDeployless(
    calls: StepCall[],
    blockParam: string | Record<string, unknown>,
  ): Promise<RawResult[]> {
    // Build the aggregate3 calldata (4-byte selector + encoded args)
    const call3s = calls.map((call) => ({
      target: call.target,
      allowFailure: true,
      callData: encodeFunctionData({
        abi: call.abi,
        functionName: call.functionName,
        args: call.args as any,
      }),
    }))

    // Encode as the `data` argument to the wrapper: aggregate3(calls) calldata
    const aggregate3Calldata = encodeFunctionData({
      abi: multicall3Abi,
      functionName: 'aggregate3',
      args: [call3s],
    })

    // Deployless call: wrapper deploys Multicall3, then calls aggregate3 on it
    const deployData = encodeDeployData({
      abi: parseAbi(['constructor(bytes code, bytes data)']),
      bytecode: DEPLOYLESS_WRAPPER_BYTECODE,
      args: [MULTICALL3_BYTECODE, aggregate3Calldata],
    })

    const result = await this.#provider.request({
      method: 'eth_call',
      params: [{ data: deployData }, blockParam],
    })

    return this.#decodeResults(result as `0x${string}`, calls)
  }

  // ─── Result decoding ─────────────────────────────────────────────

  #decodeResults(
    returnData: `0x${string}`,
    calls: StepCall[],
  ): RawResult[] {
    // aggregate3 returns Result[] = (bool success, bytes returnData)[]
    const decoded = decodeFunctionResult({
      abi: multicall3Abi,
      functionName: 'aggregate3',
      data: returnData,
    }) as { success: boolean; returnData: `0x${string}` }[]

    return decoded.map((result, i) => {
      if (!result.success) {
        return {
          status: 'failure' as const,
          error: new Error(`Call ${calls[i]?.key ?? i} reverted`),
        }
      }
      try {
        const call = calls[i]!
        const value = decodeFunctionResult({
          abi: call.abi,
          functionName: call.functionName,
          data: result.returnData,
        })
        // Unwrap single-element arrays (matching viem's behavior)
        const unwrapped = Array.isArray(value) && value.length === 1 ? value[0] : value
        return { status: 'success' as const, value: unwrapped }
      } catch (error) {
        return { status: 'failure' as const, error }
      }
    })
  }
}
