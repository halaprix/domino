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
