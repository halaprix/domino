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

**Sequential, self-triggering on-chain reads.**

## Quick Start

Standard multicall batches calls that are **known upfront**. But what about when Step 2 depends on Step 1? You either make N×M sequential RPC calls, or you make fewer calls than you could. `domino` solves this with an FSM executor: each step's calls are batched, and results flow into the next step automatically.

```bash
npm install @halaprix/domino
```

## Features

- **Sequential steps**: FSM executor automatically resolves state-dependent contract reads.
- **2-step vault resolution**: Built-in support for ERC4626 metadata and `convertToAssets`.
- **Bulk operations**: Resolve N vaults or tokens in O(steps) RPC calls instead of O(N).
- **Framework-agnostic core**: Works with viem, ethers v5, and ethers v6.
- **Tiny footprint**: ~2.1KB gzip wrapper, tree-shakeable engines (only your chosen library is bundled).

## Installation

Pick your preferred engine. The library is framework-agnostic, and unused engines are tree-shaken out.

For the v5 engine, explicitly install ethers v5 in addition to the main package:

```bash
npm install @halaprix/domino
npm install ethers@^5  # v5 engine only
```

## Usage

### viem (Recommended)

```typescript
import { createPublicClient, http, mainnet } from "viem";
import { createResolver } from "@halaprix/domino/viem";

const client = createPublicClient({ chain: mainnet, transport: http() });
const resolver = createResolver(client);

// ERC20 token with owner balance
const token = await resolver.resolveErc20({
  token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  owner: "0xd8dA6BF26764cbF84d5537Bd0c02F5f6bCF9A1d9",
});
// { symbol: "USDC", decimals: 6, balance: 12345678n }

// Bulk ERC4626 vault resolution (2-step: metadata + convertToAssets)
const vaults = await resolver.resolveErc4626Bulk({
  entries: vaultAddresses.map((addr) => ({ vault: addr, owner: "0xd8d..." })),
});
// Resolves all M vaults in exactly 2 multicall rounds
```

### ethers v6

```typescript
import { BrowserProvider } from "ethers";
import { createResolver } from "@halaprix/domino/ethers-v6";

const provider = new BrowserProvider(window.ethereum);
const resolver = createResolver(provider);

const token = await resolver.resolveErc20({ token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" });
```

### ethers v5

> **Requires ethers v5:** `npm install ethers@^5`

```typescript
import { providers } from "ethers";
import { createResolver } from "@halaprix/domino/ethers-v5";

const provider = new providers.Web3Provider(window.ethereum);
const resolver = createResolver(provider);

const vault = await resolver.resolveErc4626({ vault: "0x...", owner: "0x..." });
```

## Documentation

- [API Reference](docs/api-reference.md)
- [Benchmarks & Comparisons](docs/benchmarks.md)
- [Architecture & AI Context](CLAUDE.md)
- [Historical Specification](docs/SPEC.md)

## Contributing

See our [Contributing Guide](CONTRIBUTING.md) for details on how to set up the repository, run tests, and submit pull requests.

## License

[MIT](LICENSE)
