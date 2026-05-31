# Contributing to multistep-multicall

Thank you for your interest in contributing! This guide covers everything you need to set up, develop, test, and ship changes.

## Project Overview

`multistep-multicall` is a TypeScript library that wraps Multicall3 with a finite state machine executor for **sequential, state-dependent contract reads**. The core insight: when step N+1 depends on step N results, standard multicall batches fall short. This library reduces N×M RPC calls to M multicalls.

**Key exports:**
- `runMultistepTasks` — core FSM executor
- `buildErc20Task` / `resolveErc20Token` / `resolveErc20TokensBulk` — ERC20 token resolution
- `buildErc4626Task` / `resolveErc4626Vault` / `resolveErc4626VaultsBulk` — ERC4626 vault resolution
- Engine adapters: `createResolver` from `.../engines/viem`, `.../engines/ethers-v6`, `.../engines/ethers-v5`

## Repository Structure

```
src/
├── core/
│   ├── types.ts               # MultistepTask, StepCall, StepResult, StepExecutor, Address
│   └── runMultistepTasks.ts   # FSM executor
├── engines/
│   ├── viem.ts                # viem PublicClient adapter (createResolver)
│   ├── ethers-v6.ts           # ethers v6 adapter (createResolver)
│   ├── ethers-v5.ts           # ethers v5 adapter (createResolver)
│   └── shared.ts              # Shared executor factory + ResolverEngine type
├── handlers/
│   ├── erc20.ts               # buildErc20Task + resolveErc20Token + resolveErc20TokensBulk
│   └── erc4626.ts             # buildErc4626Task + resolveErc4626Vault + resolveErc4626VaultsBulk
├── abis/
│   ├── erc.ts                 # ERC20 / ERC4626 JSON ABI fragments (shared by every engine)
│   └── multicall3.ts          # Multicall3 ABI + address
├── __tests__/                 # vitest specs mirroring the source tree
│   ├── engines/
│   │   ├── viem.test.ts
│   │   ├── ethers-v6.test.ts
│   │   ├── ethers-v5.test.ts
│   │   └── integration.test.ts
│   ├── erc20.test.ts
│   ├── erc4626.test.ts
│   ├── multistepMulticall.test.ts
│   └── bundle-size.test.ts
└── index.ts                   # Public API surface
```

## Development Setup

```bash
git clone <repo-url>
cd multistep-multicall
npm install
```

No additional setup is required. The project uses [tsup](https://tsup.egoist.dev) for bundling and vitest for tests.

## Available Scripts

```bash
npm run build      # Type-check + bundle with tsup (+ postbuild rewrite)
npm run dev        # Watch mode rebuild
npm run test       # Run all tests (vitest)
npm run test:coverage  # Run tests with coverage report
npm run lint       # ESLint check
npm run lint:fix   # ESLint auto-fix
npm run typecheck  # tsc --noEmit
```

## Architecture

### The MultistepTask contract

Every handler implements `MultistepTask<TResult>`:

```typescript
interface MultistepTask<TResult> {
  maxStep: number;                    // highest step index (1-based)
  buildStepCalls(step: number): StepCall[];   // calls for this step
  consumeStepResults(step: number, results: StepResult[]): void; // route results
  finalize(): TResult;               // produce final result
}
```

`runMultistepTasks` iterates steps 1..maxStep, calls `buildStepCalls` for all tasks at once (so they batch into one multicall), routes results back to each task via `consumeStepResults`, then calls `finalize` on all tasks.

### StepExecutor abstraction

`StepExecutor` is the pluggable backend for the multicall execution:

```typescript
interface StepExecutor {
  executeMulticall(calls: StepCall[]): Promise<RawResult[]>;
}
```

Engines implement this interface for their respective client libraries (viem, ethers v5, ethers v6). Handlers only know about `StepCall[]` and `StepResult[]` — they are engine-agnostic.

### Handler conventions

Each handler file (`erc20.ts`, `erc4626.ts`) exports three layers:
1. **`build<Name>Task()`** — factory returning a `MultistepTask` (for users building custom pipelines)
2. **`resolve<Name>()`** — single-entry convenience function
3. **`resolve<Name>Bulk()`** — bulk convenience function

ABIs live in `src/abis/erc.ts` as JSON ABI objects (not human-readable strings) — viem's encoder requires parsed ABI; ethers accepts the same JSON.

## Testing

Tests live in `src/__tests__/`. Engine-specific tests live in `src/__tests__/engines/`.

### Running tests

```bash
npm run test              # Run all tests once
npm run test -- --watch   # Watch mode
npm run test:coverage     # With coverage
```

### Test patterns

**Handler/FSM tests** mock the `StepExecutor` to isolate the `buildStepCalls` / `consumeStepResults` / `finalize` logic:

```typescript
import { runMultistepTasks } from "../core/runMultistepTasks";
import type { StepExecutor } from "../core/types";

const mockExecutor: StepExecutor = {
  async executeMulticall(calls) {
    return calls.map(() => ({ status: "success", value: 18n }));
  },
};
```

**Engine unit tests** mock the transport boundary — `client.multicall` (viem) or the ethers `Interface` — so they do **not** exercise real ABI encoding.

**Integration test** (`src/__tests__/engines/integration.test.ts`) drives a real viem `PublicClient` (stub transport) and real ethers `Interface`, exercising actual encode/decode. Extend this when changing ABIs or executors.

### Adding a new handler

1. Create `src/handlers/<name>.ts` implementing `build<Name>Task()` + `resolve<Name>()` + `resolve<Name>Bulk()`.
2. Add exports to `src/index.ts`.
3. Add a test file `src/__tests__/<name>.test.ts`.
4. If the handler needs a new ABI, add it to `src/abis/` and import from there.

### Adding a new engine

1. Create `src/engines/<engine>.ts` exporting `createResolver`.
2. Add exports to `src/index.ts`.
3. Add a test file `src/__tests__/engines/<engine>.ts`.
4. Register the entry point in `tsup.config.ts`.

## Commit Conventions

This project follows [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add ethers-v5 engine adapter
fix: resolveErc20Token owner parameter order
refactor: extract shared handler factories
docs: add CONTRIBUTING.md
test: add tree-shaking verification
```

Prefixes: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`

## Pull Request Process

1. **Fork and branch** from `main`: `git checkout -b feat/my-feature`.
2. **Run quality gates** before opening a PR:
   ```bash
   npm run build # must pass
   npm run test    # all tests must pass
   npm run lint    # no lint errors
   ```
3. **Tests are required** for all new behavior. Add tests in `src/__tests__/`.
4. **Keep PRs focused** — one feature or fix per PR.
5. **Update `CHANGELOG.md`** if the change affects the public API.
6. **Fill out the PR template** if one exists.

## Code Style

- **Strict TypeScript** — `strict: true` in `tsconfig.json`. No `any`.
- **`noUncheckedIndexedAccess: true`** — always handle potential undefined array/index access.
- **Explicit return types** on exported functions.
- **No default exports** — use named exports only.
- **Max line length**: 100 characters (enforced by ESLint).

## Publishing

The `prepublishOnly` script runs `npm run build && npm test` — you can't accidentally publish broken dist. CI publishes automatically when a GitHub Release is created (workflow: `publish.yml`).

## Reporting Issues

Bug reports welcome! Please include:
- Library version (`npm list @halaprix/multistep-multicall`)
- Node / npm versions
- Minimal reproduction case (code or repo link)
- Expected vs actual behavior

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
