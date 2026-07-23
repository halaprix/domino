# Migration Guide — v0.1.0 → v1.0.0

## What changed

- **Ethers engines removed.** Use `Eip1193Executor` with any EIP-1193 provider (viem, ethers, window.ethereum).
- **Block tags added.** Query historical state at any `blockNumber`, `blockTag`, or `blockHash`.
- **Deployless multicall.** Automatic fallback when Multicall3 wasn't deployed yet at the target block.
- **viem is now a hard dependency** (was optional in v0.1.0).
- Subpath exports (`@halaprix/domino/viem`, `/ethers-v6`, `/ethers-v5`) removed.

## Before (v0.1.0)

<!-- snippet: skip -->

```typescript
import { createPublicClient, http, mainnet } from "viem"
import { createResolver } from "@halaprix/domino/viem"

const client = createPublicClient({ chain: mainnet, transport: http() })
const resolver = createResolver(client)
const vault = await resolver.resolveErc4626({ vault: "0x...", owner: "0x..." })
```

## After (v1.0.0)

```typescript
import { createPublicClient, http } from "viem"
import { mainnet } from "viem/chains"
import { Eip1193Executor, resolveErc4626Vault } from "@halaprix/domino"

const provider = createPublicClient({ chain: mainnet, transport: http() })
const executor = new Eip1193Executor(provider)
const vault = await resolveErc4626Vault({
  client: executor,
  vault: "0x...",
  owner: "0x...",
})

// Historical block query:
const oldVault = await resolveErc4626Vault({
  client: executor,
  vault: "0x...",
  owner: "0x...",
  block: { blockNumber: 19_000_000n },
})
```

## Breaking Changes

| v0.1.0 API | v1.0.0 API |
|--------|--------|
| `createViemExecutor(client)` | `new Eip1193Executor(provider)` |
| `createResolver(client)` | `new MulticallResolver(executor)` |
| `import ... from "@halaprix/domino/viem"` | `import ... from "@halaprix/domino"` |
| `import ... from "@halaprix/domino/ethers-v6"` | removed |
| `import ... from "@halaprix/domino/ethers-v5"` | removed |

## New Features in v1.0.0

- **Block tags:** `{ blockNumber: 5_000_000n }`, `{ blockTag: 'latest' }`, `{ blockHash: '0x...' }`
- **Deployless multicall:** Works on chains/blocks where Multicall3 was never deployed
- **EIP-1193 provider:** Works with any provider implementing `request({ method, params })`

## v1.0.x → v1.1.0

**Source-compatible, with one new runtime restriction.** Every 1.0.x program that builds a fresh task per run (the pattern every built-in convenience function — `resolveErc20Token`, `resolveErc4626Bulk`, etc. — already followed internally) keeps working unmodified. The one behavior change: domino-built task instances (`defineTask`, `buildErc20Task`, `buildErc4626Task` output) are now enforced single-run — submitting the same instance to `runMultistepTasks`/`runSettled` a second time throws `DominoTaskReuseError` instead of silently running again. Reusing such an instance was already unsound in 1.0.x (it closes over mutable per-run state, so a second run could silently mix stale and fresh data rather than erroring); 1.1.0 turns that latent bug into a loud failure. If you were holding onto a built task instance and reusing it across runs, switch to calling the builder/factory fresh for each run (see [Single-run task contract](#single-run-task-contract) below) — this section otherwise remains a guide to the new recommended surface, not a required migration.

### New: `defineTask` — describe dependent calls directly

Instead of hand-writing a `MultistepTask` (still fully supported — see the [API Reference](docs/api-reference.md#legacy-hand-written-multisteptask-definetasks-compilation-target)), `defineTask` lets you call something, get back a `Ref` to its result, and feed the `Ref` into a later call's `args`/`target`:

```typescript
import { defineTask, runMultistepTasks } from "@halaprix/domino"
import type { Address, StepExecutor } from "@halaprix/domino"

declare const executor: StepExecutor
declare const vault: Address
declare const owner: Address

const vaultAbi = [
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
] as const

const task = defineTask((t) => {
  const balance = t.call({ target: vault, abi: vaultAbi, functionName: "balanceOf", args: [owner] })
  const assets = t.call({ target: vault, abi: vaultAbi, functionName: "convertToAssets", args: [balance] })
  return { balance, assets }
})

const [result] = await runMultistepTasks(executor, [task])
```

`defineTask` output (like `buildErc20Task`/`buildErc4626Task` output) is single-run — see [Single-run task contract](#single-run-task-contract) below.

### New: `runSettled` — per-task failure isolation

```typescript
import { runSettled } from "@halaprix/domino"
import type { MultistepTask, StepExecutor } from "@halaprix/domino"

declare const executor: StepExecutor
declare const tasks: MultistepTask<{ a: number }>[]

const settled = await runSettled(executor, tasks)
// settled[i]: { status: 'fulfilled', value, diagnostics } | { status: 'rejected', error, diagnostics }
```

Full semantics (rejection rules, batch-failure isolation, and the pre-1.2 bisection limitation): see [API Reference § `runSettled`](docs/api-reference.md#runsettled--per-task-settlement).

### New: `executor:` param (`client:` deprecated)

Every resolver/handler function now accepts `executor:`. `client:` is unchanged and still works — it's just deprecated:

```typescript
import { createPublicClient, http } from "viem"
import { mainnet } from "viem/chains"
import { Eip1193Executor, resolveErc4626Vault } from "@halaprix/domino"

const provider = createPublicClient({ chain: mainnet, transport: http() })
const executor = new Eip1193Executor(provider)

const vault = await resolveErc4626Vault({
  executor, // was: client: executor
  vault: "0x...",
  owner: "0x...",
})
```

### New: canonical bulk names

`resolveErc20Bulk`/`resolveErc4626Bulk` are now the canonical names. `resolveErc20TokensBulk`/`resolveErc4626VaultsBulk` still work — they're the exact same function object (`resolveErc20TokensBulk === resolveErc20Bulk`), kept as `@deprecated` aliases through the rest of the 1.x line.

### Deprecations

| Deprecated | Replacement | Notes |
|---|---|---|
| `client:` param | `executor:` | Both still accepted; passing both throws `"Pass either 'executor' or 'client', not both — they are aliases ('client' is deprecated)"`. |
| `resolveErc20TokensBulk` | `resolveErc20Bulk` | Same function object, forever-in-1.x alias. |
| `resolveErc4626VaultsBulk` | `resolveErc4626Bulk` | Same function object, forever-in-1.x alias. |
| `Erc4626VaultResolution.metadata.maxWithdraw`/`.maxRedeem` | `Erc4626VaultResolution.position.maxWithdraw`/`.maxRedeem` | Same values when both present; `position`'s copies are optional keys (omitted, not `undefined`, on call failure). |
| `makeResolver(executor)` | `new MulticallResolver(executor)` | Equivalent — `makeResolver` is kept as a function-call convenience wrapper. |

### Single-run task contract

Every task domino itself builds — `defineTask` output, `buildErc20Task`/`buildErc4626Task` output — is now single-run: submitting the same instance to `runMultistepTasks`/`runSettled` twice (a second separate call, or twice in one `tasks` array) throws `DominoTaskReuseError`. If you were holding onto a built task instance and reusing it across multiple runs, switch to calling the builder/factory fresh for each run. Every convenience function (`resolveErc20Token`, `resolveErc4626Bulk`, etc.) already builds a fresh task internally on each call, so calling those repeatedly with the same params was never affected by this. Hand-written `MultistepTask` objects are unaffected — they were never branded and remain reusable if you keep them stateless, exactly as in 1.0.
