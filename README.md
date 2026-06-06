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
[![bundle size](https://img.shields.io/badge/gzip-1.8%E2%80%932.4KB-brightgreen)](https://www.npmjs.com/package/@halaprix/domino)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue)](https://www.typescriptlang.org/)
[![MIT License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**A state machine for on-chain reads.** Define steps, push results through. One multicall per step.

```bash
npm install @halaprix/domino
```

## But wait — it's just a state machine

Multicall is great for batched reads. But what about when step 2 needs step 1's results?

Instead of N separate RPC calls per step, domino runs your state machine **as a batch** — one `multicall` per step. You define the steps, it wires them together.

```typescript
import { createPublicClient, http, mainnet } from "viem"
import { MulticallResolver, Eip1193Executor } from "@halaprix/domino"

const provider = createPublicClient({ chain: mainnet, transport: http() })
const resolver = new MulticallResolver(new Eip1193Executor(provider))

// 🧠 Any state machine — define steps, domino batches them:
const result = await resolver.run({
  taskName: "price-check",

  // Step 1: batch of independent reads
  *steps() {
    yield {
      calls: [
        { key: "price", abi: oracleAbi, functionName: "latestAnswer" },
        { key: "decimals", abi: erc20Abi, functionName: "decimals" },
      ],
    }

    // Step 2: uses results from step 1
    const price = this.getResult("price").value
    const decimals = this.getResult("decimals").value
    const scaledPrice = price * (10n ** (18n - decimals))

    yield {
      calls: [], // optional — if you need more steps
    }
  },

  // finalize: assemble the answer
  finalize() {
    const price = this.getResult("price").value
    const decimals = this.getResult("decimals").value
    return { price, decimals, scaledPrice: price * (10n ** (18n - decimals)) }
  },
})
```

That's the whole API. Two pages — read the source of [`erc4626.ts`](src/handlers/erc4626.ts) if you want to see a complete example.

## Built-in task builders

For convenience, domino ships with pre-built task builders:

```typescript
import { buildErc4626Task, resolveErc4626Vault } from "@halaprix/domino"

// One vault — 2 multicalls (metadata + convertToAssets)
const vault = await resolveErc4626Vault({
  client: executor,
  vault: "0x...",
  owner: "0x...",
})
// { name, symbol, decimals, balance, assets, ... }

// 100 vaults — still just 2 multicalls
const vaults = await resolveErc4626VaultsBulk({
  client: executor,
  entries: vaultAddresses.map(a => ({ vault: a, owner })),
})
```

Same pattern for ERC20, and you can `buildErc4626Task()` / `buildErc20Task()` to compose them into custom pipelines.

## Historical blocks

Query any block with EIP-1898:

```typescript
const oldVault = await resolveErc4626Vault({
  client: executor,
  vault: "0x...",
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
| `resolveErc4626Vault()` | One-shot ERC4626: `{ name, assets, ... }` |
| `BlockParam` | `{ blockNumber?, blockTag?, blockHash? }` |

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
