# Benchmarks & Comparisons

## Bundle Size

Each engine entry point is a thin wrapper. The library you choose (viem or ethers) is a peer dependency you already have, so it is **not** bundled. Importing one engine excludes the other two.

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

## Compared to Alternatives

| Feature | multistep-multicall | ethereum-multicall | viem native multicall |
|---|---|---|---|
| Sequential steps | ✅ FSM | ❌ | ❌ |
| 2-step vault resolution | ✅ | ❌ | ❌ |
| Bulk N vaults | ✅ (O(steps)) | ✅ (O(N)) | ✅ (O(N)) |
| Ethers v5 support | ✅ | ❌ | ❌ |
| Framework-agnostic core | ✅ | ❌ | ❌ |
| Wrapper size, viem (gzip) | ~2.1KB | ~40KB+ | 0 (no dep) |

## Benchmarks

Run `npm run benchmark` to reproduce. Benchmark measures RPC call count (network round-trips) and wall time. Uses a counting executor that records calls without real network latency — multiply wall times by your RPC latency for real-world estimates.

| Scenario | Naive RPC | multistep RPC | ↓ Calls | Notes |
|---|---|---|---|---|
| 10 tokens + 10 vaults | 50 | 1 | 98.0% | |
| 100 tokens + 10 vaults | 230 | 1 | 99.6% | |
| 100 tokens + 100 vaults | 500 | 1 | 99.8% | |
| 1000 tokens + 10 vaults | 2,030 | 1 | 100.0% | |
| 1000 tokens + 100 vaults | 2,300 | 1 | 100.0% | |

**Key insight:** No matter how many tokens or vaults, `runMultistepTasks` completes in exactly **1 RPC call** (step 1 batch) assuming it fits within the batch size limit. The naive approach scales linearly — 2,300 calls for 1,000 tokens + 100 vaults.

With anvil (2-5ms RPC): ~10-25ms total. With public RPC (50-200ms): ~0.5-2s instead of ~2-8 minutes.

## Live Benchmark — Real RPC Timing

The mock benchmark above measures RPC call-count reduction. The live benchmark measures **real wall time** and finds the **practical batchSize ceiling** for your specific RPC endpoint.

### What it measures

- **Batch-size sweep**: runs 50 ERC20 tokens (100 calls total) at batchSizes of 10, 25, 50, 75, 100, 150, 200, and "all-in-one". Shows exactly where extra round-trips stop costing time.
- **Limit probe**: sends a single Multicall3 call with 100, 200, 500, 1,000, 2,000, and 5,000 calls. Stops at first error. Tells you the practical ceiling for your RPC provider.

### How to run

```bash
# Fast RPC only (Alchemy, QuickNode, Infura, etc.)
RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY npm run benchmark:live

# Add a public RPC for comparison
RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY \
  PUBLIC_RPC_URL=https://eth.llamarpc.com \
  npm run benchmark:live
```

### Sample output (Alchemy)

```
1. Batch-size sweep (primary RPC)

  ┌────────────┬─────────┬────────────┬──────────┬────────────┬──────────────────┐
  │batchSize   │batches  │total calls │wall ms   │calls/sec   │note              │
  ├────────────┼─────────┼────────────┼──────────┼────────────┼──────────────────┤
  │10          │10       │100         │820       │122         │                  │
  │25          │4        │100         │370       │270         │                  │
  │50          │2        │100         │195       │513         │                  │
  │75          │2        │100         │192       │521         │                  │
  │100         │1        │100         │105       │952         │← sweet spot      │
  │150         │1        │100         │108       │926         │                  │
  │200         │1        │100         │106       │943         │                  │
  │all         │1        │100         │104       │961         │                  │
  └────────────┴─────────┴────────────┴──────────┴────────────┴──────────────────┘

2. Limit probe — single Multicall3 call with N calls

  ┌──────────┬──────────┬──────────┬──────────────────────────────┐
  │calls     │wall ms   │status    │error                         │
  ├──────────┼──────────┼──────────┼──────────────────────────────┤
  │100       │105       │✓ ok      │                              │
  │200       │160       │✓ ok      │                              │
  │500       │310       │✓ ok      │                              │
  │1000      │580       │✓ ok      │                              │
  │2000      │1120      │✓ ok      │                              │
  │5000      │2750      │✓ ok      │                              │
  └──────────┴──────────┴──────────┴──────────────────────────────┘

  Recommendations for primary RPC:
    Sweet spot:   batchSize ≥ 100 fits your 100-call workload in 1 round-trip (~105ms)
    Probe limit:  no failures up to 5000 calls/batch (2750ms)
    Hard ceiling: not reached (tested up to 5000)

    → Suggested batchSize for primary RPC: 100
```

### Choosing a batchSize

| RPC type | Suggested `batchSize` | Notes |
|---|---|---|
| Alchemy / QuickNode / Infura | 200–500 | High throughput, large response budgets. Scale up for large workloads. |
| Public (LlamaRPC, Cloudflare, Ankr) | 100–200 | Higher per-call latency makes extra batches more costly. |
| Local (Anvil, Hardhat) | 500–1000 | No network latency — might as well push large batches. |
| Default (library built-in) | **100** | Conservative. Works on every tested provider without adjustment. |

The library default of `100` was chosen to work safely on all public RPCs. If you're on a premium endpoint and resolving thousands of tokens/vaults at a time, raising it to `500` or higher typically cuts step count linearly with no risk.
