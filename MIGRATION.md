# Migration Guide — v0.1.0 → v1.0.0

## What changed

- **Ethers engines removed.** Use `Eip1193Executor` with any EIP-1193 provider (viem, ethers, window.ethereum).
- **Block tags added.** Query historical state at any `blockNumber`, `blockTag`, or `blockHash`.
- **Deployless multicall.** Automatic fallback when Multicall3 wasn't deployed yet at the target block.
- **viem is now a hard dependency** (was optional in v0.1.0).
- Subpath exports (`@halaprix/domino/viem`, `/ethers-v6`, `/ethers-v5`) removed.

## Before (v0.1.0)

```typescript
import { createPublicClient, http, mainnet } from "viem"
import { createResolver } from "@halaprix/domino/viem"

const client = createPublicClient({ chain: mainnet, transport: http() })
const resolver = createResolver(client)
const vault = await resolver.resolveErc4626({ vault: "0x...", owner: "0x..." })
```

## After (v1.0.0)

```typescript
import { createPublicClient, http, mainnet } from "viem"
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
