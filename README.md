# multistep-multicall

[![CI](https://github.com/halaprix/multistep-multicall/actions/workflows/ci.yml/badge.svg)](https://github.com/halaprix/multistep-multicall/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@halaprix/multistep-multicall)](https://www.npmjs.com/package/@halaprix/multistep-multicall)
[![bundle size](https://img.shields.io/badge/gzip-1.8%E2%80%932.4KB-brightgreen)](https://www.npmjs.com/package/@halaprix/multistep-multicall)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue)](https://www.typescriptlang.org/)
[![MIT License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Batched on-chain data resolution for sequential, state-dependent reads.**

```
npm install @halaprix/multistep-multicall
```

Works with [viem](https://viem.sh), [ethers v6](https://docs.ethers.org/), or [ethers v5](https://docs.ethers.io/) — pick one, the other two are tree-shaken out.

---

## The problem it solves

Standard multicall batches calls that are **known upfront**. But what about:

```
Step 1: Read vault.balanceOf(owner)     → get raw share balance
Step 2: Read vault.convertToAssets(balance)  → depends on step 1 result
```

You either make N×M sequential RPC calls, or you give up and make fewer calls than you could.
`multistep-multicall` solves this with an FSM executor: each step's calls are batched, and results flow into the next step automatically. For M vault positions that each need a 2-step pipeline, that's **2 multicall rounds** instead of 2M calls.

---

## Quick Start

### viem

```typescript
import { createPublicClient, http, mainnet } from "viem";
import { createResolver } from "@halaprix/multistep-multicall/engines/viem";

const client = createPublicClient({
  chain: mainnet,
  transport: http(),
});

const resolver = createResolver(client);

// ERC20 token
const token = await resolver.resolveErc20({ token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" });
// { symbol: "USDC", decimals: 6, balance: undefined }

const tokenWithBalance = await resolver.resolveErc20({
  token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  owner: "0xd8dA6BF26764cbF84d5537Bd0c02F5f6bCF9A1d9",
});
// { symbol: "USDC", decimals: 6, balance: 12345678n }

// ERC4626 vault with owner (2-step: metadata + convertToAssets)
const vault = await resolver.resolveErc4626({
  vault: "0x20d36b0d76E7fA4d7c4A31A94F6d90D2cFc52F00", // ankrETH on mainnet
  owner: "0xd8dA6BF26764cbF84d5537Bd0c02F5f6bCF9A1d9",
});
// { metadata: { symbol: "ankrETH", decimals: 18, underlyingAsset: 0x..., maxWithdraw: ..., maxRedeem: ... },
//   position: { balance: 123n, assets: 4567890123456789n } }

// Bulk — all M vaults resolved in 2 multicall rounds (not M×2 calls)
const vaults = await resolver.resolveErc4626Bulk({
  entries: vaultAddresses.map((addr) => ({ vault: addr, owner: "0xd8d..." })),
});
```

### ethers v6

```typescript
import { BrowserProvider } from "ethers";
import { createResolver } from "@halaprix/multistep-multicall/engines/ethers-v6";

const provider = new BrowserProvider(window.ethereum);
const resolver = createResolver(provider); // same API as viem version

const token = await resolver.resolveErc20({ token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" });
```

### ethers v5

For the v5 engine, install ethers v5 (`npm install ethers@^5`) — the engine imports from `ethers`.

```typescript
import { providers } from "ethers";
import { createResolver } from "@halaprix/multistep-multicall/engines/ethers-v5";

const provider = new providers.Web3Provider(window.ethereum);
const resolver = createResolver(provider); // same API

const vault = await resolver.resolveErc4626({ vault: "0x...", owner: "0x..." });
```

---

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

---

## Two API layers

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
  resolveErc20Bulk(params: { entries: { token: Address; owner?: Address }[] }): Promise<Erc20TokenResolution[]>;
  resolveErc4626(params: { vault: Address; owner?: Address }): Promise<Erc4626VaultResolution>;
  resolveErc4626Bulk(params: { entries: { vault: Address; owner?: Address }[] }): Promise<Erc4626VaultResolution[]>;
}
```

### Layer 2 — Direct handler API (framework-agnostic)

The handlers run against any `StepExecutor` — the same one-method interface the
engines implement. Use this when you want a custom backend (a test double, a
batching proxy, a non-standard multicall). The `client` field is a `StepExecutor`,
**not** a viem `PublicClient` — for viem/ethers, use the engine entry points
(Layer 1), which build the executor for you.

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

---

## Return types

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

---

## Bundle size

Each engine entry point is a thin wrapper. The library you choose (viem or ethers)
is a peer dependency you already have, so it is **not** bundled. Importing one
engine excludes the other two.

```typescript
import { createResolver } from "@halaprix/multistep-multicall/engines/viem";
// ethers v5/v6 are not pulled in
```

| Entry point | Wrapper (gzip) | Peer dependency (not bundled) |
|---|---|---|
| `.../engines/viem` | ~2.1 KB | viem |
| `.../engines/ethers-v6` | ~2.3 KB | ethers v6 |
| `.../engines/ethers-v5` | ~2.4 KB | ethers v5 |
| `...` (root handlers, no engine) | ~1.8 KB | none |

---

## Compared to alternatives

| | multistep-multicall | ethereum-multicall | viem native multicall |
|---|---|---|---|
| Sequential steps | ✅ FSM | ❌ | ❌ |
| 2-step vault resolution | ✅ | ❌ | ❌ |
| Bulk N vaults | ✅ (O(steps)) | ✅ (O(N)) | ✅ (O(N)) |
| Ethers v5 support | ✅ | ❌ | ❌ |
| Framework-agnostic core | ✅ | ❌ | ❌ |
| Wrapper size, viem (gzip) | ~2.1KB | ~40KB+ | 0 (no dep) |

---

## Benchmarks

Run `npm run benchmark` to reproduce. Benchmark measures RPC call count (network round-trips) and wall time. Uses a counting executor that records calls without real network latency — multiply wall times by your RPC latency for real-world estimates.

| Scenario | Naive RPC | multistep RPC | ↓ Calls | Notes |
|---|---|---|---|---|
| 10 tokens + 10 vaults | 50 | 1 | 98.0% | |
| 100 tokens + 10 vaults | 230 | 1 | 99.6% | |
| 100 tokens + 100 vaults | 500 | 1 | 99.8% | |
| 1000 tokens + 10 vaults | 2,030 | 1 | 100.0% | |
| 1000 tokens + 100 vaults | 2,300 | 1 | 100.0% | |

**Key insight:** No matter how many tokens or vaults, `runMultistepTasks` completes in exactly **1 RPC call** (step 1 batch). The naive approach scales linearly — 2,300 calls for 1,000 tokens + 100 vaults.

With anvil (2-5ms RPC): ~10-25ms total. With public RPC (50-200ms): ~0.5-2s instead of ~2-8 minutes.

---

## Requirements

- Node.js ≥ 18
- Chain with [Multicall3](https://www.multicall.xyz/) deployed (mainnet, Sepolia, Base, Arbitrum, Optimism, Polygon, and most EVM chains have it at `0xcA11bde05977b3631167028862bE2a173976CA11`)

---

## License

MIT