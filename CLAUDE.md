# Agent Instructions

## Project Overview

`domino` is a TypeScript library that wraps Multicall3 with an FSM executor for **sequential, state-dependent contract reads**. The core insight: standard multicall libraries only batch calls known upfront. This library solves the "step N+1 depends on step N results" pattern — reducing N×M RPC calls to M multicalls.

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
│   └── types.ts               # StepCall, StepResult, RawResult, StepExecutor, MultistepTask
├── engines/
│   ├── viem.ts        # viem PublicClient.multicall
│   ├── ethers-v6.ts   # Ethers v6 via Multicall3 aggregate3
│   └── ethers-v5.ts   # Ethers v5 via Multicall3 aggregate3
├── handlers/
│   ├── erc20.ts       # buildErc20Task() + resolveErc20Token() / resolveErc20TokensBulk()
│   └── erc4626.ts     # buildErc4626Task() + resolveErc4626Vault() / resolveErc4626VaultsBulk()
├── abis/
│   ├── erc.ts         # ERC20 / ERC4626 JSON ABI fragments (shared by every engine)
│   └── multicall3.ts  # Multicall3 ABI + address
├── __tests__/         # vitest specs mirroring the source tree
└── index.ts           # Public API surface
```

## Core Interfaces

```typescript
// A single call to encode and send
interface StepCall {
  key: string;                 // routes results back to the task
  target: `0x${string}`;       // contract address
  abi: readonly unknown[];     // JSON ABI — used by the viem engine; ethers engines
                               // ignore this and encode via a shared Interface
  functionName: string;
  args?: readonly unknown[];
}

// Result of a single call, after routing to its task
interface StepResult {
  key: string;
  value: unknown;
  status?: 'failure';          // present only when the call reverted/failed
}

// Raw result returned by an executor, before routing
interface RawResult {
  status: 'success' | 'failure';
  value?: unknown;
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
import { createResolver } from "@halaprix/domino/viem";

const client = createPublicClient({ chain: mainnet, transport: http() });
const resolver = createResolver(client);

const token = await resolver.resolveErc20({ token: "0x..." });
const vault = await resolver.resolveErc4626({ vault: "0x...", owner: "0x..." });
const tokens = await resolver.resolveErc20Bulk({ entries: [{ token: "0x..." }, ...] });
```

### Ethers v6
```typescript
import { createResolver } from "@halaprix/domino/ethers-v6";
const resolver = createResolver(ethersProvider);
```

### Ethers v5
```typescript
import { createResolver } from "@halaprix/domino/ethers-v5";
const resolver = createResolver(ethersProvider);
```

## Development Workflow

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
- Handler/FSM tests mock the `StepExecutor` (`executeMulticall`) so result routing and step-gating run for real against fake data.
- Engine unit tests mock the transport boundary — `client.multicall` (viem) or the ethers `Interface` — so they do **not** exercise real ABI encoding.
- `src/__tests__/engines/integration.test.ts` closes that gap: it drives a real viem `PublicClient` (stub transport) and a real ethers `Interface`, exercising actual encode/decode. Add coverage here when changing ABIs or the executors.

## Key Constraints

- **Never use `client.multicall` directly in handler code** — always go through `runMultistepTasks` + `StepExecutor`. This ensures consistent FSM behavior across engines.
- ABIs live in `src/abis/erc.ts` as **JSON ABI objects** (not human-readable strings) — viem's encoder requires parsed ABI; ethers accepts the same JSON.
- When adding a new token standard (e.g. ERC-721), add a `src/handlers/<name>.ts` exporting both a `build<Name>Task()` factory and `resolve<Name>()` convenience functions, following the ERC20/ERC4626 pattern.
- All engines must produce identical result shapes for the same inputs — covered by `integration.test.ts`; extend it for new engines/standards.
- **Mixed-depth batches:** tasks with a shorter `maxStep` still wait for the longest task before `finalize()` is called. This is by design — batching them together saves RPC round-trips. If early results are needed, split into separate `runMultistepTasks` calls (see JSDoc on `runMultistepTasks` for the trade-off).
