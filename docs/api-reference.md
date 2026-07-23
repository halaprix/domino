# API Reference

Complete reference for `@halaprix/domino`. For a quick introduction see the [README](../README.md); for bundle size data and comparisons see [Benchmarks](benchmarks.md).

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Eip1193Executor                     │
│  • Single engine — any EIP-1193 provider             │
│  • Deployed Multicall3 when available                │
│  • Deployless (CREATE wrapper) as fallback           │
└──────────────────────┬──────────────────────────────┘
                       │ executeMulticall(calls, block?)
┌──────────────────────▼──────────────────────────────┐
│            runMultistepTasks() [FSM]                 │
│  • Finds maxStep across all tasks                   │
│  • For each step 1..maxStep:                        │
│    a. buildStepCalls() — collect calls from tasks   │
│    b. executeMulticall() — one RPC per step batch   │
│       (≤ batchSize calls)                           │
│    c. consumeStepResults() — distribute to tasks    │
│  • finalize() — assemble results                    │
└──────────────────────┬──────────────────────────────┘
                       │
          ┌────────────▼────────────┐
          │  Multicall3 (deployed)  │
          │  or deployless (CREATE) │
          └─────────────────────────┘
```

The FSM runs through all tasks step-by-step:

1. **Collect** all calls for step N from all active tasks
2. **Batch** into a single multicall call
3. **Route** results back to each task via the `key` field
4. **Repeat** for each step until all tasks are done
5. **Finalize** — each task returns its typed result

## Recommended Usage: MulticallResolver

The simplest way to use domino is via `MulticallResolver`, which wraps the executor and provides typed convenience methods for ERC20 and ERC4626:

```typescript
import { createPublicClient, http } from "viem"
import { Eip1193Executor, MulticallResolver } from "@halaprix/domino"

// Any viem client works — mainnet, testnet, custom RPC
const provider = createPublicClient({ transport: http() })
const executor = new Eip1193Executor(provider)
const resolver = new MulticallResolver(executor)

const token = await resolver.resolveErc20({
  token: "0x1234567890123456789012345678901234567890" as const,
  owner: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as const,
})

console.log(token.symbol, token.decimals, token.balance)
```

The resolver also supports bulk operations:

```typescript
import { MulticallResolver } from "@halaprix/domino"

declare const resolver: MulticallResolver

const tokens = await resolver.resolveErc20Bulk({
  entries: [
    { token: "0x1111111111111111111111111111111111111111" as const },
    { token: "0x2222222222222222222222222222222222222222" as const },
  ],
})

const vaults = await resolver.resolveErc4626Bulk({
  entries: [
    { vault: "0x3333333333333333333333333333333333333333" as const, owner: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as const },
  ],
})
```

## Extending via Custom Tasks

The core primitive is the `MultistepTask` coupled with `runMultistepTasks`. All built-in resolver methods are thin wrappers. Use the generic `run<T>()` method to execute custom tasks:

```typescript
import { buildErc20Task, MulticallResolver } from "@halaprix/domino"

declare const resolver: MulticallResolver

// Use built-in task builders
const erc20Tasks = [
  buildErc20Task({ token: "0x1111111111111111111111111111111111111111" as const }),
]

const [token] = await resolver.run(erc20Tasks)
```

Or define your own task for custom contracts:

```typescript
import { runMultistepTasks } from "@halaprix/domino"
import type { StepCall, StepResult, MultistepTask, StepExecutor, Address } from "@halaprix/domino"

declare const executor: StepExecutor

interface MyResult {
  balance: bigint | undefined
}

// Minimal ERC20 balanceOf ABI
const balanceOfAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const

// Use closure to store context across steps
const ctx: { balance?: bigint } = {}

const myTask: MultistepTask<MyResult> = {
  maxStep: 1,

  buildStepCalls(step) {
    if (step !== 1) return []
    return [
      {
        key: "balance",
        target: "0x1111111111111111111111111111111111111111" as Address,
        abi: balanceOfAbi,
        functionName: "balanceOf",
        args: ["0x2222222222222222222222222222222222222222" as Address],
      },
    ]
  },

  consumeStepResults(step, results) {
    for (const result of results) {
      if (result.status === "failure") continue
      if (result.key === "balance" && typeof result.value === "bigint") {
        ctx.balance = result.value
      }
    }
  },

  finalize() {
    return { balance: ctx.balance }
  },
}

const [result] = await runMultistepTasks(executor, [myTask])
```

## Framework-Agnostic Handlers

For testing or custom backends, use the handler functions directly with any `StepExecutor`:

```typescript
import { resolveErc4626Vault } from "@halaprix/domino"
import type { StepExecutor, RawResult, StepCall } from "@halaprix/domino"

const executor: StepExecutor = {
  async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
    // Execute `calls` however you like; return one RawResult per call, in order.
    return calls.map(() => ({ status: "success" as const, value: undefined }))
  },
}

const vault = await resolveErc4626Vault({
  client: executor,
  vault: "0x3333333333333333333333333333333333333333" as const,
  owner: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as const,
})
```

## Return Types

```typescript
import type { Address } from "@halaprix/domino"

// ERC20
interface Erc20TokenResolution {
  symbol: string | undefined
  decimals: number | undefined
  balance: bigint | undefined // undefined if no owner provided
}

// ERC4626
interface Erc4626VaultResolution {
  metadata: {
    symbol: string | undefined
    decimals: number | undefined
    underlyingAsset: Address | undefined
    maxWithdraw: bigint | undefined  // unlimited = 2^256-1
    maxRedeem: bigint | undefined    // unlimited = 2^256-1
  }
  position: { balance: bigint; assets: bigint | undefined } | undefined
  //   balance = raw share balance (vault.balanceOf(owner))
  //   assets  = underlying amount (vault.convertToAssets(balance))
}
```

## API Surface

Import the following directly from `@halaprix/domino`:

**Core functions:**
- `runMultistepTasks<T>(executor: StepExecutor, tasks: MultistepTask<T>[], options?: BatchOptions): Promise<T[]>`

**Eip1193Executor class:**
- `constructor(provider: Eip1193Provider)`
- `executeMulticall(calls: StepCall[], block?: BlockParam): Promise<RawResult[]>`
- `refreshChainId(): Promise<number>`

**MulticallResolver class:**
- `constructor(executor: StepExecutor)`
- `get executor(): StepExecutor`
- `run<T>(tasks: MultistepTask<T>[], options?: BatchOptions): Promise<T[]>`
- `resolveErc20(params: { token: Address; owner?: Address; block?: BlockParam }): Promise<Erc20TokenResolution>`
- `resolveErc20Bulk(params: { entries: { token: Address; owner?: Address }[]; batchSize?: number; block?: BlockParam }): Promise<Erc20TokenResolution[]>`
- `resolveErc4626(params: { vault: Address; owner?: Address; block?: BlockParam }): Promise<Erc4626VaultResolution>`
- `resolveErc4626Bulk(params: { entries: { vault: Address; owner?: Address }[]; batchSize?: number; block?: BlockParam }): Promise<Erc4626VaultResolution[]>`

**Constants and deployment helpers:**
- `MULTICALL3_ADDRESS: Address`
- `MULTICALL3_BYTECODE: string`
- `DEPLOYLESS_WRAPPER_BYTECODE: string`
- `MULTICALL3_DEPLOYMENTS: Record<number, { blockCreated: bigint }>`
- `shouldUseDeployless(chainId: number, block?: BlockParam): boolean`

**Handler task builders:**
- `buildErc20Task(params: { token: Address; owner?: Address }): MultistepTask<Erc20TokenResolution>`
- `resolveErc20Token(params: { client: StepExecutor; token: Address; owner?: Address; block?: BlockParam }): Promise<Erc20TokenResolution>`
- `resolveErc20TokensBulk(params: { client: StepExecutor; entries: { token: Address; owner?: Address }[]; batchSize?: number; block?: BlockParam }): Promise<Erc20TokenResolution[]>`
- `buildErc4626Task(params: { vault: Address; owner?: Address }): MultistepTask<Erc4626VaultResolution>`
- `resolveErc4626Vault(params: { client: StepExecutor; vault: Address; owner?: Address; block?: BlockParam }): Promise<Erc4626VaultResolution>`
- `resolveErc4626VaultsBulk(params: { client: StepExecutor; entries: { vault: Address; owner?: Address }[]; batchSize?: number; block?: BlockParam }): Promise<Erc4626VaultResolution[]>`

**Types:**
- `StepCall` — a single call in a multicall batch
- `StepResult` — result of a call routed back to its task
- `MultistepTask<T>` — stateful task pipeline
- `StepExecutor` — executor interface (one method: `executeMulticall`)
- `RawResult` — raw return value before routing
- `Address` — hex string type alias
- `BlockParam` — block identifier (blockNumber, blockTag, or blockHash)
- `BlockTag` — 'latest' | 'earliest' | 'pending' | 'safe' | 'finalized'
- `Eip1193Provider` — minimal EIP-1193 provider interface
- `BatchOptions` — { batchSize?: number; block?: BlockParam }
- `ResolverEngine` — interface with `run<T>()` and typed resolve methods
- `Erc20TokenResolution` — return type for ERC20 queries
- `Erc4626VaultResolution` — return type for ERC4626 queries
