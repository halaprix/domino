# Benchmarks & Comparisons

## Bundle Size

`@halaprix/domino` is a lightweight wrapper. The package size (gzip) is **10.9 KB**. The library requires viem as a hard dependency.

```typescript
import { Eip1193Executor, MulticallResolver } from "@halaprix/domino"
import { createPublicClient, http } from "viem"

const provider = createPublicClient({ transport: http() })
const executor = new Eip1193Executor(provider)
const resolver = new MulticallResolver(executor)
```

| Package | Size (gzip) | Notes |
|---|---|---|
| `@halaprix/domino` | 10.9 KB | viem is a hard dependency; installed with the package, not bundled into dist |

## Compared to Alternatives

| Feature | domino | ethereum-multicall | viem native multicall |
|---|---|---|---|
| Sequential steps (FSM) | ✅ | ❌ | ❌ |
| 2-step vault resolution | ✅ | ❌ | ❌ |
| Cross-entity step batching | ✅ | ❌ | ❌ |
| Framework-agnostic core | ✅ | ❌ | ❌ |
| Size (gzip) | 10.9 KB | ~40 KB | 0 (no dep) |

## RPC Round-Trip Counts

Benchmark measures network round-trips for various token/vault combinations. All scenarios assume **owner is present** (so balances and positions are queried). Table shows round-trips at two batch sizes: the default (100) and unlimited (all calls in one batch).

**Run model:** All round-trip counts assume a single combined `runMultistepTasks` call that batches ERC20 tokens and ERC4626 vaults together (e.g., `resolver.run([...erc20Tasks, ...erc4626Tasks])`). This allows ERC20 calls to share step 1 batches with vault metadata calls. If you call `resolveErc20TokensBulk` and `resolveErc4626VaultsBulk` separately, each executes independently and may add round-trips.

**Key insight:** With unlimited batchSize, most scenarios complete in **2 round-trips** (1 for ERC20 + vault metadata step, 1 for vault position step). At default batchSize of 100, larger scenarios require more round-trips due to call volume splitting.

| Scenario | Naive RPC | Round-trips @ batchSize 100 | Round-trips @ batchSize ∞ |
|---|---|---|---|
| 10 tokens + 10 vaults | 100 | 2 | 2 |
| 100 tokens + 10 vaults | 370 | 5 | 2 |
| 100 tokens + 100 vaults | 1,000 | 10 | 2 |
| 1,000 tokens + 10 vaults | 3,070 | 32 | 2 |
| 1,000 tokens + 100 vaults | 3,700 | 37 | 2 |

**Call breakdown by type:**
- Each ERC20 token: 3 calls (symbol, decimals, balanceOf)
- Each ERC4626 vault: 7 calls total (step 1: symbol, decimals, asset, balanceOf, maxWithdraw, maxRedeem; step 2: convertToAssets)

**Formula:**
- Round-trips = ⌈(tokens × 3 + vaults × 6) / batchSize⌉ + ⌈(vaults × 1) / batchSize⌉
- At batchSize ∞: always 2 round-trips (assuming vaults > 0)
- At batchSize 100 (default): each 100 calls = 1 round-trip

## Live Benchmark — Real RPC Timing

The mock benchmark above measures RPC call-count reduction. The live benchmark measures **real wall time** and finds the **practical batchSize ceiling** for your specific RPC endpoint.

### What it measures

- **Batch-size sweep**: runs 50 ERC20 tokens (100 calls total: 50 × 2 symbol + decimals, no owner) at batchSizes of 10, 25, 50, 75, 100, 150, 200, and "all-in-one". Shows exactly where extra round-trips stop costing time.
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
