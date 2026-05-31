# multistep-multicall

A TypeScript library that wraps viem's Multicall3 with a **finite state machine executor** for sequential, state-dependent contract reads.

## Why

Standard multicall libraries (viem native, ethereum-multicall) only batch calls that are known upfront. `multistep-multicall` solves the "step N+1 depends on step N results" pattern — reducing N×M RPC calls to M multicalls.

## Install

```bash
npm install multistep-multicall
```

Requires `viem@^2.0.0` as a peer dependency.

## Quick Start

```typescript
import { createPublicClient, http } from "viem";
import { resolveErc4626Vault } from "multistep-multicall";

const client = createPublicClient({
  chain: mainnet,
  transport: http(),
});

const vault = "0x...";
const owner = "0x...";

const resolution = await resolveErc4626Vault({ client, vault, owner });
// Step 1: symbol, decimals, asset(), balanceOf, maxWithdraw, maxRedeem
// Step 2: convertToAssets(balance) — uses result from step 1

console.log(resolution.metadata.symbol);    // "ankrETH"
console.log(resolution.position?.assets);   // 1234567890123456n (underlying amount)
```

## Core API

### MultistepTask<T>

```typescript
interface MultistepTask<TResult> {
  maxStep: number;
  buildStepCalls(step: number): StepCall[];
  consumeStepResults(step: number, results: StepResult[]): void;
  finalize(): TResult;
}
```

### runMultistepTasks

```typescript
async function runMultistepTasks<TResult>(
  client: PublicClient,
  tasks: MultistepTask<TResult>[]
): Promise<TResult[]>
```

## License

MIT