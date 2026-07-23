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
[![bundle size](https://img.shields.io/badge/gzip-12.2KB-brightgreen)](https://www.npmjs.com/package/@halaprix/domino)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue)](https://www.typescriptlang.org/)
[![MIT License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**A state machine for on-chain reads.** Define steps, push results through. One multicall per step.

```bash
npm install @halaprix/domino
```

**Requires `viem` as a runtime dependency** (installed automatically). Works with any EIP-1193 provider — a viem `PublicClient`, `window.ethereum`, or any object exposing `request({ method, params })`. (ethers users need an EIP-1193 adapter.)

## Define the dependency, not the state machine

Multicall is great for batched reads. But what about when step 2 needs step 1's result?

`defineTask` lets you describe that dependency directly: call something, get back a `Ref` to its result, feed the `Ref` straight into the next call's `args` (or even its `target`). domino works out how many steps that graph needs, executes one multicall per step batch (a step with more calls than `batchSize` splits into several sequential batches), and resolves every `Ref` before handing you back a plain typed object.

```typescript
import { createPublicClient, http } from "viem"
import { mainnet } from "viem/chains"
import { Eip1193Executor, defineTask, runMultistepTasks } from "@halaprix/domino"
import type { Address } from "@halaprix/domino"

const provider = createPublicClient({ chain: mainnet, transport: http() })
const executor = new Eip1193Executor(provider)

const vaultAddress = "0x1234567890123456789012345678901234567890" as Address
const ownerAddress = "0x0987654321098765432109876543210987654321" as Address

// Human-readable ABI — the friendliest way to describe a call.
const vaultAbi = [
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
] as const

// A factory: call this fresh for each vault/owner pair — domino tasks are
// single-run (see "Single-use tasks" below), so `vaultPosition(vault, owner)`
// returning a new `defineTask(...)` each time is the idiom, not a shared const.
function vaultPosition(vault: Address, owner: Address) {
  return defineTask((t) => {
    // Step 1: read the owner's share balance.
    const balance = t.call({
      target: vault,
      abi: vaultAbi,
      functionName: "balanceOf",
      args: [owner],
    })

    // Step 2: `balance` (a Ref<bigint>) feeds straight into convertToAssets's
    // args — domino waits for step 1, then builds this call from the result.
    const assets = t.call({
      target: vault,
      abi: vaultAbi,
      functionName: "convertToAssets",
      args: [balance],
    })

    // t.derive computes a value from already-resolved Refs — no extra RPC call.
    const hasBalance = t.derive([balance], (bal) => bal > 0n)

    return { balance, assets, hasBalance }
  })
}

const [result] = await runMultistepTasks(executor, [vaultPosition(vaultAddress, ownerAddress)])
// result.balance:    balanceOf output from step 1
// result.assets:      convertToAssets(balance) output from step 2
// result.hasBalance:  derived locally from balance, no extra RPC call
```

Same task runs via a resolver too, if you're already holding one: `await resolver.run([vaultPosition(vaultAddress, ownerAddress)])`. For per-task failure isolation instead of one bad task aborting the whole call, swap in `runSettled`/`resolver.runSettled` — see the [API Reference](docs/api-reference.md#runsettled--per-task-settlement).

### Single-use tasks

Every task domino builds (`defineTask`, `buildErc20Task`, `buildErc4626Task`) is **single-run**: submit it to `runMultistepTasks`/`runSettled` once, and a second submission of that same instance throws `DominoTaskReuseError`. That's why the idiom above is a factory function (`vaultPosition(vault, owner)`) rather than a module-level constant — call the factory again to get a fresh instance for the next run.

## What it compiles to — hand-written `MultistepTask`

`defineTask` output *is* a `MultistepTask` — the same `buildStepCalls`/`consumeStepResults`/`finalize` shape you'd write by hand. That hand-written form is still there as an escape hatch, for full control over step gating and result routing that the ref-graph builder can't express (yet):

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

Unlike a `defineTask` output, a hand-written `MultistepTask` like this one is **not** single-use by default — it's plain data, reusable if you keep it stateless. Read the source of [`erc4626.ts`](src/handlers/erc4626.ts) for a production example written this way.

## Built-in task builders

For convenience, domino ships with pre-built task builders:

```typescript
import { createPublicClient, http } from "viem"
import { mainnet } from "viem/chains"
import { Eip1193Executor, resolveErc4626Vault, resolveErc4626Bulk } from "@halaprix/domino"
import type { Address } from "@halaprix/domino"

const provider = createPublicClient({ chain: mainnet, transport: http() })
const executor = new Eip1193Executor(provider)

const vaultAddress = "0x1234567890123456789012345678901234567890" as Address
const ownerAddress = "0x0987654321098765432109876543210987654321" as Address

// One vault — 2 steps (metadata + convertToAssets)
const vault = await resolveErc4626Vault({
  executor,
  vault: vaultAddress,
  owner: ownerAddress,
})
// Returns: { metadata: { symbol, decimals, underlyingAsset, ... }, position: { balance, assets } }

// 100 vaults + owner at default batchSize 100:
//   Step 1: 6 calls/vault = 600 calls = 6 batches
//   Step 2: 1 call/vault = 100 calls = 1 batch
//   Total: 7 round-trips
const vaultAddrs = Array(100).fill("0x1234567890123456789012345678901234567890") as Address[]
const vaults = await resolveErc4626Bulk({
  executor,
  entries: vaultAddrs.map(v => ({ vault: v, owner: ownerAddress })),
})
```

Same pattern for ERC20 (`resolveErc20Token` / `resolveErc20Bulk`), and you can `buildErc4626Task()` / `buildErc20Task()` to compose them into custom pipelines — both are single-run factories too, same contract as `defineTask`.

`resolveErc4626Bulk`/`resolveErc20Bulk` are the canonical names (F11). The original `resolveErc4626VaultsBulk`/`resolveErc20TokensBulk` names still work — they're `@deprecated` aliases pointing at the same function (`resolveErc4626VaultsBulk === resolveErc4626Bulk`), kept for the rest of the 1.x line.

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
  executor,
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
| `defineTask()` | **Recommended.** Ref-graph task builder — `t.call`/`t.derive`, compiles to a `MultistepTask` |
| `runSettled()` | Per-task settlement — every task gets its own fulfilled/rejected outcome instead of one failure aborting the whole call |
| `MulticallResolver` | Convenience layer — call `run()`/`runSettled()` to execute a state machine |
| `Eip1193Executor` | Single engine — works with any EIP-1193 provider |
| `runMultistepTasks()` | Core FSM — bare-metal version of the resolver |
| `DominoCallError` | Structured error for a failed call — `kind` discriminates revert/decode/batch/skipped/derive |
| `DominoTaskReuseError` | Thrown when a single-run task (`defineTask`/`buildErc20Task`/`buildErc4626Task` output) is submitted twice |
| `buildErc20Task()` | Build a task definition for ERC20 token reads |
| `buildErc4626Task()` | Build a task definition for ERC4626 vault reads |
| `resolveErc20Token()` | One-shot ERC20: `{ symbol, decimals, balance }` |
| `resolveErc20Bulk()` | Bulk ERC20 (canonical name — `resolveErc20TokensBulk` is a deprecated alias) |
| `resolveErc4626Vault()` | One-shot ERC4626: `{ metadata: { symbol, decimals, ... }, position: { balance, assets } \| undefined }` |
| `resolveErc4626Bulk()` | Bulk ERC4626 (canonical name — `resolveErc4626VaultsBulk` is a deprecated alias) |
| `executor:` | Preferred param name on the four standalone `resolve*` functions (`resolveErc20Token`, `resolveErc20Bulk`, `resolveErc4626Vault`, `resolveErc4626Bulk`) — `client:` still works there but is deprecated. `MulticallResolver` methods don't take it per-call; the executor is passed once, to the constructor. |
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
