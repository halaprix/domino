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

Returns a `ResolverEngine` with a uniform API regardless of which library you chose:

```typescript
interface ResolverEngine {
  resolveErc20(params: { token: Address; owner?: Address }): Promise<Erc20TokenResolution>;
  resolveErc20Bulk(params: { entries: { token: Address; owner?: Address }[]; batchSize?: number }): Promise<Erc20TokenResolution[]>;
  resolveErc4626(params: { vault: Address; owner?: Address }): Promise<Erc4626VaultResolution>;
  resolveErc4626Bulk(params: { entries: { vault: Address; owner?: Address }[]; batchSize?: number }): Promise<Erc4626VaultResolution[]>;
}
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
