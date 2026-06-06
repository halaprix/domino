# Agent Instructions

## Project Overview

`domino` is a TypeScript library that wraps Multicall3 with an FSM executor for **sequential, state-dependent contract reads**. v2 uses a single `Eip1193Executor` — works with any EIP-1193 provider (viem, ethers, window.ethereum). Supports historical block queries and deployless multicall for chains/blocks where Multicall3 wasn't deployed.

## Architecture (v2)

```
┌─────────────────────────────────────────────────────┐
│                  Eip1193Executor                     │
│  • Single engine — any EIP-1193 provider             │
│  • Deployed Multicall3 when available                │
│  • Deployless (CREATE wrapper) as fallback           │
└──────────────────────┬──────────────────────────────┘
                       │ executeMulticall(calls, block?)
┌──────────────────────▼──────────────────────────────┐
│            runMultistepTasks() [FSM]                 │
│  • Finds maxStep across all tasks                   │
│  • For each step 1..maxStep:                        │
│    a. buildStepCalls() — collect calls from tasks   │
│    b. executeMulticall() — one RPC per step         │
│    c. consumeStepResults() — distribute to tasks    │
│  • finalize() — assemble results                    │
└──────────────────────┬──────────────────────────────┘
                       │
          ┌────────────▼────────────┐
          │  Multicall3 (deployed)  │
          │  or deployless (CREATE) │
          └─────────────────────────┘
```

## Directory Structure (v2)

```
src/
├── core/
│   ├── runMultistepTasks.ts   # FSM executor (framework-agnostic)
│   ├── types.ts               # StepCall, StepResult, BlockParam, Eip1193Provider, etc.
│   └── abi.ts                 # Re-exports from viem/utils
├── engine/
│   ├── eip1193.ts             # Eip1193Executor — deployed + deployless
│   ├── resolver.ts            # MulticallResolver — typed convenience layer
│   ├── bytecodes.ts           # Vendored Multicall3 + deployless wrapper bytecodes
│   └── deployments.ts         # Per-chain Multicall3 deployment block registry
├── handlers/
│   ├── erc20.ts       # buildErc20Task() + resolveErc20Token() / resolveErc20TokensBulk()
│   └── erc4626.ts     # buildErc4626Task() + resolveErc4626Vault() / resolveErc4626VaultsBulk()
├── __tests__/         # vitest specs mirroring the source tree
└── index.ts           # Public API surface
```

## Usage (v2)

```typescript
import { createPublicClient, http, mainnet } from "viem"
import { Eip1193Executor, resolveErc4626Vault } from "@halaprix/domino"

const provider = createPublicClient({ chain: mainnet, transport: http() })
const executor = new Eip1193Executor(provider)

// Current block (default)
const vault = await resolveErc4626Vault({
  client: executor,
  vault: "0x...",
  owner: "0x...",
})

// Historical block
const oldVault = await resolveErc4626Vault({
  client: executor,
  vault: "0x...",
  block: { blockNumber: 19_000_000n },
})
```

## Development Workflow

```bash
# Before committing — MUST pass all three:
npm run lint      # eslint (zero errors)
npm run typecheck # tsc --noEmit (zero errors)
npm test          # vitest (all pass)

# Formatting is enforced by eslint. No separate formatter needed.

# Build
npm run build     # tsup — single ESM/CJS entry
```

**Commit rules:**
- One commit per logical change
- Author: `halaprix <halaprix@users.noreply.github.com>`
- Run lint + typecheck + tests before every commit
- No `console.log` left in production code
- No stale imports or dead code paths

## Testing Patterns

- Tests live in `src/__tests__/` mirroring the source tree.
- Handler/FSM tests mock the `StepExecutor` (`executeMulticall`) so result routing and step-gating run for real against fake data.
- Engine tests mock the EIP-1193 provider (`request` method) — no real RPC calls.
- Deployless tests verify bytecode integrity, encoding, and the `shouldUseDeployless()` logic.

## Key Constraints

- **Never use `client.multicall` directly in handler code** — always go through `runMultistepTasks` + `StepExecutor`.
- **Eip1193Executor** is the sole engine. No per-library engines (viem/ethers-v5/ethers-v6 removed in v2).
- ABIs are **inlined in handler files** as `const` arrays (no separate `abis/` directory).
- When adding a new token standard, add a `src/handlers/<name>.ts` exporting both a `build<Name>Task()` factory and `resolve<Name>()` convenience functions.
- **Deployless fallback**: when Multicall3 wasn't deployed at the target block, the executor automatically uses CREATE-style `eth_call` with the vendored wrapper bytecode.
- **Bytecodes are vendored** from viem's constants — do not edit by hand. Run `scripts/verify-bytecodes.ts` after viem upgrades.
- **Mixed-depth batches:** tasks with shorter `maxStep` wait for the longest task. This is by design — batching saves RPC round-trips. Split into separate `runMultistepTasks` calls for early results.
