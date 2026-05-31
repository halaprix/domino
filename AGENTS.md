# Agent Instructions

## Project Overview

`multistep-multicall` is a TypeScript library that wraps Multicall3 with an FSM executor for **sequential, state-dependent contract reads**. The core insight: standard multicall libraries only batch calls known upfront. This library solves the "step N+1 depends on step N results" pattern — reducing N×M RPC calls to M multicalls.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  ResolverEngine                     │
│   (viem / ethers-v6 / ethers-v5 adapter)            │
└──────────────────────┬──────────────────────────────┘
                       │ StepExecutor.executeMulticall()
┌──────────────────────▼──────────────────────────────┐
│            runMultistepTasks() [FSM]                 │
│  • Finds maxStep across all tasks                   │
│  • For each step 1..maxStep:                        │
│    a. buildStepCalls() — collect calls from tasks   │
│    b. executeMulticall() — one RPC per step        │
│    c. consumeStepResults() — distribute to tasks    │
│  • finalize() — assemble results                    │
└──────────────────────┬──────────────────────────────┘
                       │ StepCall[]
┌──────────────────────▼──────────────────────────────┐
│                  Multicall3                         │
│              (on-chain aggregator)                   │
└─────────────────────────────────────────────────────┘
```

## Directory Structure

```
src/
├── core/
│   ├── runMultistepTasks.ts   # FSM executor (framework-agnostic)
│   ├── types.ts               # StepCall, StepResult, MultistepTask, StepExecutor
│   ├── adapters.ts            # Adapter exports
│   └── MultistepTask.ts       # (may be unused, check before editing)
├── engines/
│   ├── viem.ts        # ViemExecutor using viem's built-in multicall3
│   ├── ethers-v6.ts   # Ethers v6 executor via Multicall3 aggregate3
│   └── ethers-v5.ts   # Ethers v5 executor via Multicall3 aggregate3
├── handlers/
│   ├── erc20-task.ts    # buildErc20Task() — MultistepTask factory
│   ├── erc4626-task.ts  # buildErc4626Task() — MultistepTask factory
│   ├── erc20.ts         # resolveErc20Token() / resolveErc20TokensBulk()
│   ├── erc4626.ts       # resolveErc4626Vault() / resolveErc4626VaultsBulk()
│   └── index.ts         # Handler exports
├── abis/
│   └── multicall3.ts    # Multicall3 ABI + address
└── index.ts             # Public API surface
```

## Core Interfaces

```typescript
// A single call to encode and send
interface StepCall {
  key: string;            // used to route results back to task
  target: Address;        // contract address
  abi: Abi;              // ABI fragment (viem)
  functionName: string;
  args?: unknown[];
}

// Result of a single call
interface StepResult {
  key: string;
  value: unknown;
}

// Framework-agnostic multicall executor
interface StepExecutor {
  executeMulticall(calls: StepCall[]): Promise<RawResult[]>;
}

// One unit of state-dependent work
interface MultistepTask<TResult> {
  maxStep: number;
  buildStepCalls(step: number): StepCall[];
  consumeStepResults(step: number, results: StepResult[]): void;
  finalize(): TResult;
}
```

## Engines

### Viem (primary, recommended)
```typescript
import { createPublicClient, http } from "viem";
import { createResolver } from "multistep-multicall/engines/viem";

const client = createPublicClient({ chain: mainnet, transport: http() });
const resolver = createResolver(client);

const token = await resolver.resolveErc20({ token: "0x..." });
const vault = await resolver.resolveErc4626({ vault: "0x...", owner: "0x..." });
const tokens = await resolver.resolveErc20Bulk({ entries: [{ token: "0x..." }, ...] });
```

### Ethers v6
```typescript
import { createResolver } from "multistep-multicall/engines/ethers-v6";
const resolver = createResolver(ethersProvider);
```

### Ethers v5
```typescript
import { createResolver } from "multistep-multicall/engines/ethers-v5";
const resolver = createResolver(ethersProvider);
```

## Task Workflow

```bash
# Development
npm run dev       # watch mode with tsup
npm test          # vitest
npm run build     # production build

# Before committing
npm run lint      # eslint
npm test          # ensure all tests pass
npm run build     # ensure typecheck + build succeeds
```

## Testing Patterns

- Tests live in `src/__tests__/` mirroring the source tree.
- Engine tests use a mock Multicall3 contract (anvil's pre-deployed instance on `0xcA11bde05977b3631167028862bE2a173976CA11`).
- Use `test-viem.mjs` / `test-viem.cjs` for quick ad-hoc integration checks against a live node.

## Key Constraints

- **Never use `client.multicall` directly in handler code** — always go through `runMultistepTasks` + `StepExecutor`. This ensures consistent FSM behavior across engines.
- When adding a new token standard (e.g. ERC-721), create a new `src/handlers/<name>-task.ts` + `src/handlers/<name>.ts` pair, following the ERC20/ERC4626 pattern.
- All engines must produce identical result shapes for the same inputs — test against at least two engines where possible.