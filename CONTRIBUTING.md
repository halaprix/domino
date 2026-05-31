# Contributing to multistep-multicall

Thank you for your interest in contributing! This guide covers everything you need to set up, develop, test, and ship changes.

## Project Overview

`multistep-multicall` is a TypeScript library that wraps Multicall3 with a finite state machine executor for **sequential, state-dependent contract reads**. The core insight: when step N+1 depends on step N results, standard multicall batches fall short. This library reduces N×M RPC calls to M multicalls.

**Key exports:**
- `runMultistepTasks` — core FSM executor
- `resolveErc20Token` / `resolveErc20TokensBulk` — ERC20 token resolution
- `resolveErc4626Vault` / `resolveErc4626VaultsBulk` — ERC4626 vault resolution
- Engine adapters: `createResolver` (viem), `createEthersV6Resolver`, `createEthersV5Resolver`

## Repository Structure

```
src/
  core/
    types.ts           # MultistepTask, StepCall, StepResult, StepExecutor interfaces
    runMultistepTasks.ts  # FSM executor
 adapters.ts         # viem PublicClient adapter
  engines/
    viem.ts            # viem PublicClient adapter
    ethers-v6.ts # ethers v6 adapter
    ethers-v5.ts       # ethers v5 adapter
  handlers/
    erc20.ts           # ERC20 resolution handler (public API)
    erc20-task.ts      # MultistepTask implementation for ERC20
   erc4626.ts         # ERC4626 resolution handler (public API)
    erc4626-task.ts    # MultistepTask implementation for ERC4626
 abis/ # Embedded ABI fragments
  __tests__/
    erc20.test.ts
    erc4626.test.ts
    multistepMulticall.test.ts
    engines/
 ViemExecutor.ts
      ethers-v5.ts
      ethers-v6.ts
```

## Development Setup

```bash
git clone <repo-url>
cd multistep-multicall
npm install
```

No additional setup is required. The project uses [tsx](https://github.com/privatenumber/tsx) for running TypeScript directly, and vitest for tests.

## Available Scripts

```bash
npm run build      # Type-check + bundle with tsup
npm run dev       # Watch mode rebuild
npm run test      # Run all tests (vitest)
npm run test:coverage  # Run tests with coverage report
npm run lint      # ESLint check
npm run lint:fix  # ESLint auto-fix
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

- `erc20.ts` / `erc4626.ts` — public API (named exports). Import from these, not the `*-task.ts` files.
- `erc20-task.ts` / `erc4626-task.ts` — `MultistepTask` implementation. Used internally by the public API.
- ABIs are defined as inline `const` arrays with `as const` assertion in the handler files.

## Testing

Tests live in `src/__tests__/`. Engine-specific tests live in `src/__tests__/engines/`.

### Running tests

```bash
npm run test        # Run all tests once
npm run test -- --watch  # Watch mode
npm run test:coverage  # With coverage
```

### Test patterns

**Unit tests for handlers** mock the `StepExecutor` to isolate the `buildStepCalls` / `consumeStepResults` / `finalize` logic:

```typescript
import { runMultistepTasks } from "../core/runMultistepTasks";
import type { StepExecutor } from "../core/types";

// Mock executor that returns canned results
const mockExecutor: StepExecutor = {
  async executeMulticall(calls) {
    return calls.map(() => ({ status: "success", value: 18n }));
  },
};
```

**Engine integration tests** use a real viem `PublicClient` against a mainnet fork (anvil/ganache). The mock viem executor (`ViemExecutor.ts`) is the integration point.

### Adding a new handler

1. Create `src/handlers/<name>-task.ts` implementing `MultistepTask`.
2. Create `src/handlers/<name>.ts` exposing the public API (`resolveXxx`, `resolveXxxBulk`).
3. Add exports to `src/index.ts`.
4. Add a test file `src/__tests__/<name>.test.ts`.
5. If the handler needs a new ABI, add it as a `const` array in the handler file (use `as const` for viem ABI typing).

### Adding a new engine

1. Create `src/engines/<engine>.ts` implementing `StepExecutor`.
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
5. **Update `CHANGELOG.md`** (or add a `CHANGELOG` entry) if the change affects the public API.
6. **Fill out the PR template** if one exists.

## Code Style

- **Strict TypeScript** — `strict: true` in `tsconfig.json`. No `any`.
- **`noUncheckedIndexedAccess: true`** — always handle potential undefined array/index access.
- **Explicit return types** on exported functions.
- **No default exports** — use named exports only.
- **Max line length**: 100 characters (enforced by ESLint).

## Reporting Issues

Bug reports welcome! Please include:
- Library version (`npm list multistep-multicall`)
- Node / npm versions
- Minimal reproduction case (code or repo link)
- Expected vs actual behavior

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
