# domino

```
        ┌─────────┬─────────┐
        │  ●   ●  │  ●      │
        │         │    ●    │
        │  ●   ●  │      ●  │
        └─────────┴─────────┘
   turns M calls × N steps into M multicalls

   _|                            _|
 _|_|_|    _|_|    _|_|_|  _|_|        _|_|_|      _|_|
_|    _|  _|    _|  _|    _|    _|  _|  _|    _|  _|    _|
_|    _|  _|    _|  _|    _|    _|  _|  _|    _|  _|    _|
  _|_|_|    _|_|    _|    _|    _|  _|  _|    _|    _|_|
```

[![CI](https://github.com/halaprix/domino/actions/workflows/ci.yml/badge.svg)](https://github.com/halaprix/domino/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@halaprix/domino)](https://www.npmjs.com/package/@halaprix/domino)
[![bundle size](https://img.shields.io/badge/gzip-10.7KB-brightgreen)](https://www.npmjs.com/package/@halaprix/domino)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue)](https://www.typescriptlang.org/)
[![MIT License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**A state machine for on-chain reads.** Define steps, push results through. One multicall per step.

```bash
npm install @halaprix/domino
```

**Requires `viem` as a runtime dependency** (installed automatically). Works with any EIP-1193 provider — a viem `PublicClient`, `window.ethereum`, or any object exposing `request({ method, params })`. (ethers users need an EIP-1193 adapter.)

## But wait — it's just a state machine

Multicall is great for batched reads. But what about when step 2 needs step 1's results?

Instead of N separate RPC calls per step, domino runs your state machine **as a batch** — one `multicall` per step. You define the steps, it wires them together.

```typescript
import { createPublicClient, http } from "viem"
import { mainnet } from "viem/chains"
import { Eip1193Executor, runMultistepTasks } from "@halaprix/domino"
import type { StepCall, StepResult, MultistepTask, Address } from "@halaprix/domino"

const provider = createPublicClient({ chain: mainnet, transport: http() })
const executor = new Eip1193Executor(provider)

// ERC4626 ABI fragments
const erc20Abi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const

const erc4626Abi = [
  { type: 'function', name: 'convertToAssets', stateMutability: 'view', inputs: [{ name: 'shares', type: 'uint256' }], outputs: [{ type: 'uint256' }] },
] as const

// Step 1: read vault balance; Step 2: convert balance to assets
const vaultAddress = "0x1234567890123456789012345678901234567890" as Address
const ownerAddress = "0x0987654321098765432109876543210987654321" as Address

type VaultResult = { balance: bigint | undefined; assets: bigint | undefined }

// Closure context: step 2 depends on step 1's results
const ctx: { balance?: bigint; assets?: bigint } = {}

const task: MultistepTask<VaultResult> = {
  maxStep: 2,

  buildStepCalls(step) {
    if (step === 1) {
      return [
        { key: "balance", target: vaultAddress, abi: erc20Abi, functionName: "balanceOf", args: [ownerAddress] },
      ]
    }
    if (step === 2) {
      // Skip step 2 if we didn't get a balance from step 1
      if (ctx.balance === undefined) return []
      return [
        { key: "assets", target: vaultAddress, abi: erc4626Abi, functionName: "convertToAssets", args: [ctx.balance] },
      ]
    }
    return []
  },

  consumeStepResults(step, results: StepResult[]) {
    // Route results by step: store them in ctx for next step
    for (const r of results) {
      if (r.status === 'success') {
        if (step === 1 && r.key === 'balance') {
          ctx.balance = r.value as bigint
        }
        if (step === 2 && r.key === 'assets') {
          ctx.assets = r.value as bigint
        }
      }
    }
  },

  finalize() {
    return { balance: ctx.balance, assets: ctx.assets }
  },
}

const [result] = await runMultistepTasks(executor, [task])
// result.balance: balanceOf output from step 1
// result.assets: convertToAssets(balance) output from step 2
```

That's the whole API — one `MultistepTask` per entity, batched into one `runMultistepTasks` call. Two pages — read the source of [`erc4626.ts`](src/handlers/erc4626.ts) if you want to see a production example.

## Built-in task builders

For convenience, domino ships with pre-built task builders:

```typescript
import { createPublicClient, http } from "viem"
import { mainnet } from "viem/chains"
import { Eip1193Executor, resolveErc4626Vault, resolveErc4626VaultsBulk } from "@halaprix/domino"
import type { Address } from "@halaprix/domino"

const provider = createPublicClient({ chain: mainnet, transport: http() })
const executor = new Eip1193Executor(provider)

const vaultAddress = "0x1234567890123456789012345678901234567890" as Address
const ownerAddress = "0x0987654321098765432109876543210987654321" as Address

// One vault — 2 steps (metadata + convertToAssets)
const vault = await resolveErc4626Vault({
  client: executor,
  vault: vaultAddress,
  owner: ownerAddress,
})
// Returns: { metadata: { symbol, decimals, underlyingAsset, ... }, position: { balance, assets } }

// 100 vaults + owner at default batchSize 100:
//   Step 1: 6 calls/vault = 600 calls = 6 batches
//   Step 2: 1 call/vault = 100 calls = 1 batch
//   Total: 7 round-trips
const vaultAddrs = Array(100).fill("0x1234567890123456789012345678901234567890") as Address[]
const vaults = await resolveErc4626VaultsBulk({
  client: executor,
  entries: vaultAddrs.map(v => ({ vault: v, owner: ownerAddress })),
})
```

Same pattern for ERC20, and you can `buildErc4626Task()` / `buildErc20Task()` to compose them into custom pipelines.

## Historical blocks

Query any block with EIP-1898:

```typescript
import { createPublicClient, http } from "viem"
import { mainnet } from "viem/chains"
import { Eip1193Executor, resolveErc4626Vault } from "@halaprix/domino"
import type { Address } from "@halaprix/domino"

const provider = createPublicClient({ chain: mainnet, transport: http() })
const executor = new Eip1193Executor(provider)

const vaultAddress = "0x1234567890123456789012345678901234567890" as Address
const ownerAddress = "0x0987654321098765432109876543210987654321" as Address

const oldVault = await resolveErc4626Vault({
  client: executor,
  vault: vaultAddress,
  owner: ownerAddress,
  block: { blockNumber: 19_000_000n },
})
```

Works with `blockHash`, `blockTag`, or `blockNumber`. Even on chains where Multicall3 didn't exist yet — domino falls back to deployless multicall automatically.

## When NOT to use it

- Pure batches (no dependencies) → plain `multicall` is simpler.
- Write transactions → wrong tool. This reads only.
- Single reads → just use `client.readContract()` directly.

## API at a glance

| Export | What it is |
|--------|-----------|
| `MulticallResolver` | Convenience layer — call `run()` to execute a state machine |
| `Eip1193Executor` | Single engine — works with any EIP-1193 provider |
| `runMultistepTasks()` | Core FSM — bare-metal version of the resolver |
| `buildErc20Task()` | Build a task definition for ERC20 token reads |
| `buildErc4626Task()` | Build a task definition for ERC4626 vault reads |
| `resolveErc20Token()` | One-shot ERC20: `{ symbol, decimals, balance }` |
| `resolveErc4626Vault()` | One-shot ERC4626: `{ metadata: { symbol, decimals, ... }, position: { balance, assets } \| undefined }` |
| `BlockParam` | `{ blockNumber } \| { blockTag } \| { blockHash }` (one of three) |

## Documentation

- [Architecture & AI Context](CLAUDE.md)
- [API Reference](docs/api-reference.md)
- [Benchmarks](docs/benchmarks.md)
- [Migration Guide](MIGRATION.md)
- [Changelog](CHANGELOG.md)

## Contributing

See our [Contributing Guide](CONTRIBUTING.md).

## License

[MIT](LICENSE)
