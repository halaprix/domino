# API Reference

Complete reference for `@halaprix/multistep-multicall`. For a quick introduction see the [README](../README.md); for bundle size data and comparisons see [Benchmarks](benchmarks.md).

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Your code                                              │
│                                                         │
│  createResolver(client)  →  ResolverEngine              │
│                                                         │
│  resolver.resolveErc20(...)                            │
│  resolver.resolveErc4626(...)                          │
│  resolver.resolveErc20Bulk(...)                        │
│  resolver.resolveErc4626Bulk(...)                      │
└────────────────────┬──────────────────────────────────┘
                     │
         ┌───────────┴───────────┐
         ▼                       ▼
┌────────────────┐    ┌─────────────────────┐
│ viem engine    │    │ ethers engine (v5/v6)│
│ createViemExec │    │ createEthersExec    │
│  ↓              │    │  ↓                   │
│ client.multicall│    │ mc3.aggregate3      │
└────────────────┘    └─────────────────────┘
         │                       │
         └───────────┬───────────┘
                     ▼
        ┌─────────────────────────┐
        │   runMultistepTasks()    │  ← shared FSM executor
        │   ┌─────────┬─────────┐  │
        │   │ Step 1  │ Step 2  │  │
        │   │ all     │ depends │  │
        │   │ tasks   │ on S1   │  │
        │   └─────────┴─────────┘  │
        └─────────────────────────┘
                     │
          ┌──────────┴───────────┐
          ▼                       ▼
   ┌────────────┐    ┌──────────────────┐
   │ buildErc20 │    │ buildErc4626      │
   │ Task       │    │ Task             │
   │ (maxStep=1)│    │ (maxStep=1 or 2) │
   └────────────┘    └──────────────────┘
```

The FSM runs through all tasks step-by-step:

1. **Collect** all calls for step N from all active tasks
2. **Batch** into a single multicall call
3. **Route** results back to each task via the `key` field
4. **Repeat** for each step until all tasks are done
5. **Finalize** — each task returns its typed result

## Two API Layers

### Layer 1 — Engine entry point (recommended)

Pick one at import time. The other two engines are eliminated by tree-shaking.

```typescript
import { createResolver } from "@halaprix/multistep-multicall/engines/viem";
// or "multistep-multicall/engines/ethers-v6"
```

Returns a `ResolverEngine` with a uniform API regardless of which library you chose. The `ResolverEngine` is designed as a convenience facade that provides the most common DeFi tokens (ERC20/ERC4626) built in, while also providing a generic extension point for executing custom tasks.

```typescript
interface ResolverEngine {
  /** 
   * Generic extension point — execute any MultistepTask(s) against this executor.
   * Use this for custom token standards (ERC721, Uniswap pairs, etc.) beyond
   * the built-in ERC20/ERC4626 conveniences.
   */
  run<T>(tasks: MultistepTask<T>[], options?: BatchOptions): Promise<T[]>;
  
  resolveErc20(params: { token: Address; owner?: Address }): Promise<Erc20TokenResolution>;
  resolveErc20Bulk(params: { entries: { token: Address; owner?: Address }[]; batchSize?: number }): Promise<Erc20TokenResolution[]>;
  resolveErc4626(params: { vault: Address; owner?: Address }): Promise<Erc4626VaultResolution>;
  resolveErc4626Bulk(params: { entries: { vault: Address; owner?: Address }[]; batchSize?: number }): Promise<Erc4626VaultResolution[]>;
}
```

### Extending the Engine via `run<T>()`

The core primitive of this library is the `MultistepTask` coupled with the `runMultistepTasks` runner. All built-in resolver methods (like `resolveErc20`) are simply thin wrappers over this primitive. 

If you need to fetch state from custom smart contracts, you don't need to rebuild the engine. Simply construct a custom `MultistepTask` and pass it to the `run<T>()` method:

```typescript
// Custom task definition
const myTask = buildUniswapPairTask(pairAddress);

// Execute it using the standard engine resolver
const [price] = await resolver.run([myTask]);

// Alternatively, compose the raw executor manually:
// await runMultistepTasks(resolver.executor, [myTask])
```

### Layer 2 — Direct handler API (framework-agnostic)

The handlers run against any `StepExecutor` — the same one-method interface the engines implement. Use this when you want a custom backend (a test double, a batching proxy, a non-standard multicall). The `client` field is a `StepExecutor`, **not** a viem `PublicClient` — for viem/ethers, use the engine entry points (Layer 1), which build the executor for you.

```typescript
import { resolveErc4626Vault } from "@halaprix/multistep-multicall";
import type { StepExecutor } from "@halaprix/multistep-multicall";

const executor: StepExecutor = {
  async executeMulticall(calls) {
    // Execute `calls` however you like; return one RawResult per call, in order.
    return calls.map(() => ({ status: "success", value: /* decoded value */ undefined }));
  },
};

const vault = await resolveErc4626Vault({ client: executor, vault: "0x...", owner: "0x..." });
```

Both layers share the same return types.

## Return Types

```typescript
// ERC20
interface Erc20TokenResolution {
  symbol: string | undefined;
  decimals: number | undefined;
  balance: bigint | undefined; // undefined if no owner provided
}

// ERC4626
interface Erc4626VaultResolution {
  metadata: {
    symbol: string | undefined;
    decimals: number | undefined;
    underlyingAsset: `0x${string}` | undefined;
    maxWithdraw: bigint | undefined; // unlimited = 2^256-1
    maxRedeem: bigint | undefined;   // unlimited = 2^256-1
  };
  position: { balance: bigint; assets: bigint | undefined } | undefined;
  //   balance = raw share balance (vault.balanceOf(owner))
  //   assets  = underlying amount (vault.convertToAssets(balance))
}
```
