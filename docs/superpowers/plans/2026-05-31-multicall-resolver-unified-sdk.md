# Multicall Resolver — Unified SDK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Jedna paczka `multicall-resolver` z trzema silnikami (ethers v5, ethers v6, viem), tree-shakeable entry points, pełne testy.

**Architecture:** Framework-agnostic FSM core + trzy silniki adapters. Każdy silnik implementuje ten sam `ResolverEngine` interface. Entry points osobno w dist/ — użytkownik importuje jeden silnik, dwa pozostałe wycina tree-shaking.

**Tech Stack:** TypeScript, tsup (dual CJS/ESM + per-entry config), vitest, viem v2, ethers v5, ethers v6

---

## File Structure

```
multistep-multicall/                   (rename to multicall-resolver later)
├── src/
│   ├── core/
│   │   ├── types.ts              # MultistepTask<T>, StepCall, StepResult interfaces
│   │   ├── MultistepTask.ts # Abstract base class
│   │   └── runMultistepTasks.ts  # FSM executor (framework-agnostic)
│   ├── engines/
│   │   ├── viem.ts               # createResolver(publicClient) — viem entry point
│   │   ├── ethers-v6.ts          # createResolver(provider) — ethers v6 entry point
│   │   └── ethers-v5.ts           # createResolver(provider) — ethers v5 entry point
│   ├── handlers/
│   │   ├── erc20.ts              # Erc20Task + resolveErc20Token/sBulk
│   │   └── erc4626.ts            # Erc4626Task + resolveErc4626Vault/sBulk
│   └── abis/
│       └── multicall3.ts         # multicall3 ABI + address constant
├── src/index.ts                  # Full bundle re-export
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

---

## Task 1: Restructure project layout

**Files:**
- Modify: `package.json` — rename name to `multicall-resolver`, update scripts, add dual-peerDeps structure
- Modify: `tsup.config.ts` — multi-entry: engines/viem.ts, engines/ethers-v6.ts, engines/ethers-v5.ts
- Modify: `tsconfig.json` — no changes needed (already good)
- Create: `src/core/types.ts`
- Create: `src/core/MultistepTask.ts`
- Create: `src/core/runMultistepTasks.ts`
- Create: `src/abis/multicall3.ts`
- Delete: `src/multistepMulticall.ts` (replaced by core/)
- Delete: `src/handlers/index.ts` (inline into handlers)

- [ ] **Step 1: Update package.json**

```json
{
  "name": "multicall-resolver",
  "version": "0.1.0",
  "private": false,
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    "./engines/viem": {
      "import": { "types": "./dist/engines/viem.d.ts", "default": "./dist/engines/viem.js" },
      "require": { "types": "./dist/engines/viem.d.cts", "default": "./dist/engines/viem.cjs" }
    },
    "./engines/ethers-v6": {
      "import": { "types": "./dist/engines/ethers-v6.d.ts", "default": "./dist/engines/ethers-v6.js" },
      "require": { "types": "./dist/engines/ethers-v6.d.cts", "default": "./dist/engines/ethers-v6.cjs" }
    },
    "./engines/ethers-v5": {
      "import": { "types": "./dist/engines/ethers-v5.d.ts", "default": "./dist/engines/ethers-v5.js" },
      "require": { "types": "./dist/engines/ethers-v5.d.cts", "default": "./dist/engines/ethers-v5.cjs" }
    },
    ".": {
      "import": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
      "require": { "types": "./dist/index.d.cts", "default": "./dist/index.cjs" }
    }
  },
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "test": "vitest",
    "test:coverage": "vitest --coverage",
    "lint": "eslint src"
  },
  "peerDependencies": {
    "viem": "^2.0.0",
    "ethers": "^5.0.0 || ^6.0.0"
  },
  "devDependencies": {
    "viem": "^2.39.0",
    "ethers": "^6.0.0",
    "ethers": "^5.0.0",
    "typescript": "^5.5.0",
    "tsup": "^8.0.0",
    "vitest": "^2.0.0",
    "@vitest/coverage-v8": "^2.0.0",
    "eslint": "^9.0.0",
    "typescript-eslint": "^8.0.0"
  }
}
```

- [ ] **Step 2: Create src/core/types.ts**

```typescript
export interface StepCall {
  key: string;
  target: `0x${string}`;
  abi: unknown[];
  functionName: string;
  args?: readonly unknown[];
}

export interface StepResult {
  key: string;
  value: unknown;
}

export interface MultistepTask<TResult> {
  maxStep: number;
  buildStepCalls(step: number): StepCall[];
  consumeStepResults(step: number, results: StepResult[]): void;
  finalize(): TResult;
}
```

- [ ] **Step 3: Create src/core/MultistepTask.ts**

```typescript
import type { MultistepTask as IMultistepTask, StepCall, StepResult } from "./types";

export type { MultistepTask, StepCall, StepResult } from "./types";

export abstract class MultistepTask<TResult> implements IMultistepTask<TResult> {
  abstract readonly maxStep: number;

  abstract buildStepCalls(step: number): StepCall[];
  abstract consumeStepResults(step: number, results: StepResult[]): void;
  abstract finalize(): TResult;
}
```

- [ ] **Step 4: Create src/core/runMultistepTasks.ts**

```typescript
import type { MultistepTask, StepCall, StepResult } from "./types";

export async function runMultistepTasks<TResult>(
  executor: StepExecutor,
  tasks: MultistepTask<TResult>[],
): Promise<TResult[]> {
  if (tasks.length === 0) return [];

  const maxStep = tasks.reduce((max, task) =>
    task.maxStep > max ? task.maxStep : max, 0);

  for (let step = 1; step <= maxStep; step++) {
    const calls: StepCall[] = [];
    const mapping: { taskIndex: number; key: string }[] = [];

    for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
      const task = tasks[taskIndex]!;
      if (step > task.maxStep) continue;
      const stepCalls = task.buildStepCalls(step);
      for (const call of stepCalls) {
        calls.push(call);
        mapping.push({ taskIndex, key: call.key });
      }
    }

    if (calls.length === 0) continue;

    const rawResults = await executor.executeMulticall(calls);
    const perTaskResults = new Map<number, StepResult[]>();

    for (let i = 0; i < rawResults.length; i++) {
      const entry = mapping[i];
      if (!entry) continue;
      const { taskIndex, key } = entry;
      const result = rawResults[i]!;
      if (result.status === "success") {
        let list = perTaskResults.get(taskIndex);
        if (!list) { list = []; perTaskResults.set(taskIndex, list); }
        list.push({ key, value: result.value });
      }
    }

    perTaskResults.forEach((resultsForTask, taskIndex) => {
      const task = tasks[taskIndex];
      if (task) task.consumeStepResults(step, resultsForTask);
    });
  }

  return tasks.map((task) => task.finalize());
}

export interface StepExecutor {
  executeMulticall(calls: StepCall[]): Promise<RawResult[]>;
}

export interface RawResult {
  status: "success" | "failure";
  value?: unknown;
}
```

- [ ] **Step 5: Create src/abis/multicall3.ts**

```typescript
export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

export const multicall3Abi = [
  {
    inputs: [{
      components: [
        { name: "target", type: "address" },
        { name: "allowFailure", type: "bool" },
        { name: "callData", type: "bytes" },
      ], name: "calls", type: "tuple[]",
    }],
    name: "aggregate3",
    outputs: [{
      components: [
        { name: "success", type: "bool" },
        { name: "returnData", type: "bytes" },
      ], name: "returnData", type: "tuple[]",
    }],
    stateMutability: "view",
    type: "function",
  },
] as const;
```

- [ ] **Step 6: Update tsup.config.ts**

```typescript
import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/engines/viem.ts",
    "src/engines/ethers-v6.ts",
    "src/engines/ethers-v5.ts",
    "src/index.ts",
  ],
  format: ["cjs", "esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  esbuildOptions(options) {
    // No external — all bundled together
  },
});
```

- [ ] **Step 7: Move existing handlers to new layout**

Move `src/handlers/erc20.ts` and `src/handlers/erc4626.ts` to use `src/core/runMultistepTasks.ts` as the executor. The handlers stay framework-agnostic — they accept `StepExecutor` injected.

- [ ] **Step 8: Delete old files**

```bash
rm src/multistepMulticall.ts
rm src/handlers/index.ts
```

- [ ] **Step 9: Run tests**

```bash
npx vitest run
```

Expected: all tests pass (existing tests still work since API unchanged)

- [ ] **Step 10: Commit**

```bash
git add -A && git commit -m "refactor: extract core/types + StepExecutor interface"
```

---

## Task 2: Implement viem engine

**Files:**
- Create: `src/engines/viem.ts`
- Create: `src/__tests__/engines/viem.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect, vi } from "vitest";
import { createResolver } from "../engines/viem";
import type { PublicClient } from "viem";

describe("viem engine", () => {
  it("resolves ERC20 symbol and decimals", async () => {
    const mockClient = {
      multicall: vi.fn().mockResolvedValue([
        { status: "success", result: "USDC" },
        { status: "success", result: 6n },
      ]),
    } as unknown as PublicClient;

    const resolver = createResolver(mockClient);
    const result = await resolver.resolveErc20({ token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" });

    expect(result.symbol).toBe("USDC");
    expect(result.decimals).toBe(6);
  });

  it("resolves ERC4626 with owner (2-step)", async () => {
    const mockClient = {
      multicall: vi.fn()
        .mockResolvedValueOnce([
          { status: "success", result: "usdcVAULT" },
          { status: "success", result: 6n },
          { status: "success", result: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
          { status: "success", result: 1_000_000n },
          { status: "success", result: 950_000n },
          { status: "success", result: 900_000n },
        ])
        .mockResolvedValueOnce([
          { status: "success", result: 950_000n },
        ]),
    } as unknown as PublicClient;

    const resolver = createResolver(mockClient);
    const result = await resolver.resolveErc4626({
      vault: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
      owner: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    });

    expect(result.metadata.symbol).toBe("usdcVAULT");
    expect(result.metadata.underlyingAsset).toBe("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
    expect(result.position?.balance).toBe(1_000_000n);
    expect(result.position?.assets).toBe(950_000n);
  });

  it("resolveErc20Bulk batches into single multicall", async () => {
    const mockClient = {
      multicall: vi.fn().mockResolvedValue([
        { status: "success", result: "USDC" }, { status: "success", result: 6n },
        { status: "success", result: "DAI" }, { status: "success", result: 18n },
      ]),
    } as unknown as PublicClient;

    const resolver = createResolver(mockClient);
    const results = await resolver.resolveErc20Bulk({
      entries: [
        { token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
        { token: "0x6B175474E89094C44Da98b954EedeAC495271d0F" },
      ],
    });

    expect(results).toHaveLength(2);
    expect(results[0]!.symbol).toBe("USDC");
    expect(results[1]!.symbol).toBe("DAI");
    expect(mockClient.multicall).toHaveBeenCalledTimes(1);
  });

  it("handles failed calls gracefully", async () => {
    const mockClient = {
      multicall: vi.fn().mockResolvedValue([
        { status: "failure", result: "0x" },
        { status: "success", result: 6n },
      ]),
    } as unknown as PublicClient;

    const resolver = createResolver(mockClient);
    const result = await resolver.resolveErc20({ token: "0xdead00000000000000000000000000000000dead" });
    expect(result.symbol).toBeUndefined();
    expect(result.decimals).toBe(6);
  });

  it("returns empty array for empty bulk", async () => {
    const mockClient = { multicall: vi.fn() } as unknown as PublicClient;
    const resolver = createResolver(mockClient);
    const results = await resolver.resolveErc20Bulk({ entries: [] });
    expect(results).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test — verify it fails (no implementation yet)**

Run: `npx vitest src/__tests__/engines/viem.test.ts`
Expected: FAIL — "createResolver is not a function"

- [ ] **Step 3: Implement src/engines/viem.ts**

```typescript
import { type Address, type PublicClient, erc20Abi, erc4626Abi } from "viem";
import { runMultistepTasks, type StepExecutor, type StepCall, type RawResult } from "../core/runMultistepTasks";
import type { MultistepTask } from "../core/types";

export interface Erc20TokenResolution {
  symbol?: string;
  decimals?: number;
  balance?: bigint;
}

export interface Erc4626VaultResolution {
  metadata: {
    symbol?: string;
    decimals?: number;
    underlyingAsset?: Address;
    maxWithdraw?: bigint;
    maxRedeem?: bigint;
  };
  position?: {
    balance?: bigint;
    assets?: bigint;
  };
}

export interface ResolverEngine {
  resolveErc20(params: { token: Address; owner?: Address }): Promise<Erc20TokenResolution>;
  resolveErc20Bulk(params: { entries: { token: Address; owner?: Address }[] }): Promise<Erc20TokenResolution[]>;
  resolveErc4626(params: { vault: Address; owner?: Address }): Promise<Erc4626VaultResolution>;
  resolveErc4626Bulk(params: { entries: { vault: Address; owner?: Address }[] }): Promise<Erc4626VaultResolution[]>;
}

function createViemExecutor(client: PublicClient): StepExecutor {
  return {
    async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
      const contracts = calls.map((call) => ({
        address: call.target,
        abi: call.abi as any,
        functionName: call.functionName,
        args: call.args as any,
      }));
      const results = await client.multicall({
        contracts: contracts as any,
        allowFailure: true,
        batchSize: 4 * 4096,
      });
      return results.map((r) => ({
        status: r.status === "success" ? "success" : "failure",
        value: r.status === "success" ? r.result : undefined,
      }));
    },
  };
}

function buildErc20Task(params: { token: Address; owner?: Address }) {
  const { token, owner } = params;
  const ctx: { symbol?: string; decimals?: number; balance?: bigint } = {};
  const hasOwner = !!owner;

  const task: MultistepTask<Erc20TokenResolution> = {
    maxStep: 1,
    buildStepCalls() {
      const calls: StepCall[] = [
        { key: "symbol", target: token, abi: erc20Abi as any, functionName: "symbol" },
        { key: "decimals", target: token, abi: erc20Abi as any, functionName: "decimals" },
      ];
      if (hasOwner && owner) {
        calls.push({ key: "balance", target: token, abi: erc20Abi as any, functionName: "balanceOf", args: [owner] });
      }
      return calls;
    },
    consumeStepResults(_step, results) {
      for (const r of results) {
        if (r.key === "symbol") ctx.symbol = r.value as string;
        if (r.key === "decimals") ctx.decimals = Number(r.value as bigint);
        if (r.key === "balance") ctx.balance = BigInt(r.value as string);
      }
    },
    finalize() { return { symbol: ctx.symbol, decimals: ctx.decimals, balance: ctx.balance }; },
  };
  return task;
}

function buildErc4626Task(params: { vault: Address; owner?: Address }) {
  const { vault, owner } = params;
  const ctx: { symbol?: string; decimals?: number; underlyingAsset?: Address; maxWithdraw?: bigint; maxRedeem?: bigint; balance?: bigint; assets?: bigint } = {};
  const hasOwner = !!owner;

  const task: MultistepTask<Erc4626VaultResolution> = {
    maxStep: hasOwner ? 2 : 1,
    buildStepCalls(step) {
      if (step === 1) {
        const calls: StepCall[] = [
          { key: "symbol", target: vault, abi: erc20Abi as any, functionName: "symbol" },
          { key: "decimals", target: vault, abi: erc20Abi as any, functionName: "decimals" },
          { key: "asset", target: vault, abi: erc4626Abi as any, functionName: "asset" },
        ];
        if (hasOwner && owner) {
          calls.push(
            { key: "balance", target: vault, abi: erc20Abi as any, functionName: "balanceOf", args: [owner] },
            { key: "maxWithdraw", target: vault, abi: erc4626Abi as any, functionName: "maxWithdraw", args: [owner] },
            { key: "maxRedeem", target: vault, abi: erc4626Abi as any, functionName: "maxRedeem", args: [owner] },
          );
        }
        return calls;
      }
      if (step === 2 && hasOwner && ctx.balance !== undefined) {
        return [{ key: "assets", target: vault, abi: erc4626Abi as any, functionName: "convertToAssets", args: [ctx.balance] }];
      }
      return [];
    },
    consumeStepResults(step, results) {
      for (const r of results) {
        if (step === 1) {
          if (r.key === "symbol") ctx.symbol = r.value as string;
          if (r.key === "decimals") ctx.decimals = Number(r.value as bigint);
          if (r.key === "asset") ctx.underlyingAsset = r.value as Address;
          if (hasOwner) {
            if (r.key === "balance") ctx.balance = BigInt(r.value as string);
            if (r.key === "maxWithdraw") ctx.maxWithdraw = BigInt(r.value as string);
            if (r.key === "maxRedeem") ctx.maxRedeem = BigInt(r.value as string);
          }
        }
        if (step === 2 && r.key === "assets") ctx.assets = BigInt(r.value as string);
      }
    },
    finalize() {
      return {
        metadata: { symbol: ctx.symbol, decimals: ctx.decimals, underlyingAsset: ctx.underlyingAsset, maxWithdraw: ctx.maxWithdraw, maxRedeem: ctx.maxRedeem },
        position: hasOwner ? { balance: ctx.balance, assets: ctx.assets } : undefined,
      };
    },
  };
  return task;
}

export function createResolver(client: PublicClient): ResolverEngine {
  const executor = createViemExecutor(client);

  return {
    async resolveErc20(params) {
      const [result] = await runMultistepTasks(executor, [buildErc20Task(params)]);
      return result!;
    },
    async resolveErc20Bulk(params) {
      if (params.entries.length === 0) return [];
      const tasks = params.entries.map((e) => buildErc20Task(e));
      return runMultistepTasks(executor, tasks);
    },
    async resolveErc4626(params) {
      const [result] = await runMultistepTasks(executor, [buildErc4626Task(params)]);
      return result!;
    },
    async resolveErc4626Bulk(params) {
      if (params.entries.length === 0) return [];
      const tasks = params.entries.map((e) => buildErc4626Task(e));
      return runMultistepTasks(executor, tasks);
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest src/__tests__/engines/viem.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: viem engine with createResolver"
```

---

## Task 3: Implement ethers v6 engine

**Files:**
- Create: `src/engines/ethers-v6.ts`
- Create: `src/__tests__/engines/ethers-v6.test.ts`

- [ ] **Step 1: Write failing test**

Same 5 tests as viem engine but using ethers v6 mocks:

```typescript
import { describe, it, expect, vi } from "vitest";
import { createResolver } from "../engines/ethers-v6";
import type { BrowserProvider, Contract, Interface } from "ethers";

describe("ethers v6 engine", () => {
  it("resolves ERC20 symbol and decimals", async () => {
    const mockInterface = {
      decodeFunctionResult: vi.fn()
        .mockReturnValueOnce(["USDC"])
        .mockReturnValueOnce([6n]),
    } as unknown as Interface;

    const mockContract = {
      aggregate3: vi.fn().mockResolvedValue([
        { success: true, returnData: "0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000455532430000000000000000000000000000000000000000000000000000000000" },
        { success: true, returnData: "0x0000000000000000000000000000000000000000000000000000000000000006" },
      ]),
    } as unknown as Contract;

    const mockProvider = { getNetwork: async () => ({ chainId: 1 }) } as unknown as BrowserProvider;

    const resolver = createResolver(mockProvider, mockContract, mockInterface);
    const result = await resolver.resolveErc20({ token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" });

    expect(result.symbol).toBe("USDC");
    expect(result.decimals).toBe(6);
  });

  // ... 4 more tests identical in shape to viem engine
});
```

**Note:** The ethers v6 test structure is different — ethers doesn't have a built-in `multicall` method like viem. The engine uses `Contract` with `aggregate3` directly. Pass `multicall3Contract` and `abiInterface` as constructor arguments to make it testable.

- [ ] **Step 2: Run test — verify it fails**

- [ ] **Step 3: Implement src/engines/ethers-v6.ts**

Key points:
- `createResolver(provider)` — resolves the multicall3 contract address from the network
- Uses `Contract` with `aggregate3` function
- ABI encoding via ethers `Interface`
- Returns same `ResolverEngine` interface as viem engine

```typescript
import { type Address, type BrowserProvider, Contract, Interface, parseUnits } from "ethers";
import { MULTICALL3_ADDRESS, multicall3Abi } from "../abis/multicall3";
import { runMultistepTasks, type StepExecutor, type StepCall, type RawResult } from "../core/runMultistepTasks";
import type { MultistepTask } from "../core/types";
import { erc20Abi } from "viem";
import { erc4626Abi } from "viem";

export type { Erc20TokenResolution, Erc4626VaultResolution } from "./viem";
export type { ResolverEngine } from "./viem";

export function createResolver(
  provider: BrowserProvider,
  multicall3Contract?: Contract,
  abiInterface?: Interface,
): ResolverEngine {
  // If no contract provided, create one against the standard address
  const mc3 = multicall3Contract ?? new Contract(MULTICALL3_ADDRESS, multicall3Abi, provider);
  const iface = abiInterface ?? new Interface([...erc20Abi, ...erc4626Abi]);

  const executor: StepExecutor = {
    async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
      const encoded = calls.map((call) => ({
        target: call.target,
        allowFailure: true,
        callData: iface.encodeFunctionData(call.functionName, call.args ?? []),
      }));

      const results = await mc3.aggregate3(encoded);

      return results.map((r: any, i: number) => {
        if (!r.success) return { status: "failure" as const };
        try {
          const decoded = iface.decodeFunctionResult(calls[i]!.functionName, r.returnData);
          const value = Array.isArray(decoded) ? decoded[0] : decoded;
          return { status: "success" as const, value };
        } catch {
          return { status: "failure" as const };
        }
      });
    },
  };

  // ... rest (same handler builders as viem engine, just using the executor above)
  // Reuse buildErc20Task and buildErc4626Task from viem engine or duplicate them
  // (they're framework-agnostic, they just call buildStepCalls/consumeStepResults)
}
```

**Refactor note:** Extract `buildErc20Task` and `buildErc4626Task` into `src/handlers/` as framework-agnostic factories that accept a `StepExecutor`. Both viem and ethers engines call these same factories.

- [ ] **Step 4: Run tests**

Run: `npx vitest src/__tests__/engines/ethers-v6.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: ethers v6 engine with createResolver"
```

---

## Task 4: Implement ethers v5 engine

**Files:**
- Create: `src/engines/ethers-v5.ts`
- Create: `src/__tests__/engines/ethers-v5.test.ts`

- [ ] **Step 1: Write failing test**

5 tests identical in shape to ethers v6 engine.

- [ ] **Step 2: Run test — verify it fails**

- [ ] **Step 3: Implement src/engines/ethers-v5.ts**

Key differences from v6:
- No `BrowserProvider` — use `JsonRpcProvider` or raw `Provider`
- `Contract` constructor signature: `new Contract(address, abi, provider)`
- ABI encoding: `iface.encodeFunctionData` — identical to v6
- ethers v5 uses `callStatic` for view calls OR the contract's `.call()` method

```typescript
import { type Address, type Contract, type Interface, type Provider } from "ethers";
import { MULTICALL3_ADDRESS, multicall3Abi } from "../abis/multicall3";
import { runMultistepTasks, type StepExecutor, type StepCall, type RawResult } from "../core/runMultistepTasks";
import type { MultistepTask } from "../core/types";
import { erc20Abi } from "viem";
import { erc4626Abi } from "viem";

export type { Erc20TokenResolution, Erc4626VaultResolution, ResolverEngine } from "./viem";

export function createResolver(
  provider: Provider,
  multicall3Contract?: Contract,
  abiInterface?: Interface,
): ResolverEngine {
  const mc3 = multicall3Contract ?? new Contract(MULTICALL3_ADDRESS, multicall3Abi, provider);
  const iface = abiInterface ?? new Interface([...erc20Abi, ...erc4626Abi]);

  const executor: StepExecutor = {
    async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
      const encoded = calls.map((call) => ({
        target: call.target,
        allowFailure: true,
        callData: iface.encodeFunctionData(call.functionName, call.args ?? []),
      }));

      // ethers v5: use callStatic for view calls
      const results: any[] = await mc3.callStatic.aggregate3(encoded);

      return results.map((r: any, i: number) => {
        if (!r.success) return { status: "failure" as const };
        try {
          const decoded = iface.decodeFunctionResult(calls[i]!.functionName, r.returnData);
          const value = Array.isArray(decoded) ? decoded[0] : decoded;
          return { status: "success" as const, value };
        } catch {
          return { status: "failure" as const };
        }
      });
    },
  };

  // ... reuse handler builders (same as v6)
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest src/__tests__/engines/ethers-v5.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: ethers v5 engine with createResolver"
```

---

## Task 5: Extract shared handlers + refactor engines

**Files:**
- Create: `src/handlers/erc20.ts` (framework-agnostic — takes StepExecutor)
- Create: `src/handlers/erc4626.ts` (framework-agnostic — takes StepExecutor)
- Modify: `src/engines/viem.ts` — use shared handlers
- Modify: `src/engines/ethers-v6.ts` — use shared handlers
- Modify: `src/engines/ethers-v5.ts` — use shared handlers

- [ ] **Step 1: Extract handler factories into src/handlers/erc20.ts**

The `buildErc20Task` and `buildErc4626Task` functions are currently duplicated in each engine. Extract them into shared handler files.

```typescript
// src/handlers/erc20.ts
import type { MultistepTask, StepCall, StepResult } from "../core/types";
import type { Erc20TokenResolution } from "../engines/viem";
import { erc20Abi } from "viem";
import type { Address } from "viem";

export function buildErc20Task(params: { token: Address; owner?: Address }): MultistepTask<Erc20TokenResolution> {
  const { token, owner } = params;
  const ctx: { symbol?: string; decimals?: number; balance?: bigint } = {};
  const hasOwner = !!owner;

  return {
    maxStep: 1,
    buildStepCalls() {
      const calls: StepCall[] = [
        { key: "symbol", target: token, abi: erc20Abi as any, functionName: "symbol" },
        { key: "decimals", target: token, abi: erc20Abi as any, functionName: "decimals" },
      ];
      if (hasOwner && owner) {
        calls.push({ key: "balance", target: token, abi: erc20Abi as any, functionName: "balanceOf", args: [owner] });
      }
      return calls;
    },
    consumeStepResults(_step, results) {
      for (const r of results) {
        if (r.key === "symbol") ctx.symbol = r.value as string;
        if (r.key === "decimals") ctx.decimals = Number(r.value as bigint);
        if (r.key === "balance") ctx.balance = BigInt(r.value as string);
      }
    },
    finalize() { return { symbol: ctx.symbol, decimals: ctx.decimals, balance: ctx.balance }; },
  };
}
```

- [ ] **Step 2: Extract handler factories into src/handlers/erc4626.ts**

Same pattern — `buildErc4626Task` as a framework-agnostic factory.

- [ ] **Step 3: Refactor viem.ts to use shared handlers**

Remove duplicated `buildErc20Task` and `buildErc4626Task`, import from `../handlers/`.

- [ ] **Step 4: Refactor ethers-v6.ts to use shared handlers**

Same — import from `../handlers/`.

- [ ] **Step 5: Refactor ethers-v5.ts to use shared handlers**

Same — import from `../handlers/`.

- [ ] **Step 6: Run all tests**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "refactor: extract shared handler factories"
```

---

## Task 6: Build verification + entry point test

**Files:**
- Modify: `src/index.ts` — full bundle re-export
- Create: `src/__tests__/bundle-size.test.ts` — verify each engine bundle excludes other engines

- [ ] **Step 1: Create src/index.ts**

```typescript
export { createResolver as createViemResolver } from "./engines/viem";
export { createResolver as createEthersV6Resolver } from "./engines/ethers-v6";
export { createResolver as createEthersV5Resolver } from "./engines/ethers-v5";
export type { ResolverEngine, Erc20TokenResolution, Erc4626VaultResolution } from "./engines/viem";
```

- [ ] **Step 2: Run build**

Run: `npx tsup`
Expected: produces `dist/engines/viem.js`, `dist/engines/ethers-v6.js`, `dist/engines/ethers-v5.js`, `dist/index.js`

- [ ] **Step 3: Verify bundle sizes**

```bash
ls -la dist/engines/
```

Expected:
- `viem.js` — no ethers in bundle (~8KB)
- `ethers-v6.js` — no viem in bundle (~12KB)
- `ethers-v5.js` — no viem in bundle (~12KB)

Verify with `grep -c "ethers" dist/engines/viem.js` → should be 0 or minimal
Verify with `grep -c "viem" dist/engines/ethers-v6.js` → should be 0 or minimal

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add shared index.ts + build verification"
```

---

## Task 7: Tree-shaking tests + bundle minification

**Files:**
- Create: `src/__tests__/bundle-size.test.ts`
- Modify: `tsup.config.ts` — add minify + esbuild target
- Modify: `package.json` — add size-limit scripts

- [ ] **Step 1: Write bundle size test**

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

describe("bundle tree-shaking", () => {
  const distDir = join(__dirname, "../../dist/engines");

  it("viem bundle should NOT contain ethers", () => {
    const content = readFileSync(join(distDir, "viem.js"), "utf8");
    expect(content).not.toMatch(/from ["']ethers/);
    expect(content).not.toMatch(/require\(["']ethers/);
  });

  it("ethers-v6 bundle should NOT contain viem", () => {
    const content = readFileSync(join(distDir, "ethers-v6.js"), "utf8");
    expect(content).not.toMatch(/from ["']viem/);
    expect(content).not.toMatch(/require\(["']viem/);
  });

  it("ethers-v5 bundle should NOT contain viem", () => {
    const content = readFileSync(join(distDir, "ethers-v5.js"), "utf8");
    expect(content).not.toMatch(/from ["']viem/);
    expect(content).not.toMatch(/require\(["']viem/);
  });

  it("viem bundle should NOT contain ethers-v5 or ethers-v6", () => {
    const content = readFileSync(join(distDir, "viem.js"), "utf8");
    expect(content).not.toMatch(/ethers.*v5/);
    expect(content).not.toMatch(/ethers.*v6/);
  });

  it("each engine bundle should be under 20KB gzipped", () => {
    const { gzipSync } = require("zlib");
    const files = ["viem.js", "ethers-v6.js", "ethers-v5.js"];
    for (const file of files) {
      const raw = readFileSync(join(distDir, file));
      const gzipped = gzipSync(raw);
      const kb = (gzipped.length / 1024).toFixed(1);
      expect(gzipped.length, `${file} gzipped: ${kb}KB`).toBeLessThan(20 * 1024);
    }
  });
});
```

- [ ] **Step 2: Update tsup.config.ts — add minification**

```typescript
import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/engines/viem.ts",
    "src/engines/ethers-v6.ts",
    "src/engines/ethers-v5.ts",
    "src/index.ts",
  ],
  format: ["cjs", "esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  minify: true,
  target: "es2020",
  esbuildOptions(options) {
    options.platform = "browser";
    options.target = "es2020";
  },
});
```

- [ ] **Step 3: Run build + tests**

```bash
npx tsup && npx vitest run src/__tests__/bundle-size.test.ts
```

Expected: ALL PASS — viem bundle <20KB gzipped, no cross-engine contamination.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: add tree-shaking tests + minified builds"
```

---

## Task 8: Solidity generic MultistepMulticall — research only

**Files:**
- No code changes — research task only

This task is for the `researcher` profile. Investigate whether a generic Solidity `MultistepMulticall` contract makes sense as a separate repo.

**Research questions:**
1. Is there already a battle-tested generic version? (check GitHub, open-source)
2. What would a generic version look like? (arbitrary ABI per call, not just ERC20/ERC4626)
3. Gas cost comparison: generic vs our current hardcoded handlers
4. Use cases beyond ERC20/ERC4626 resolution
5. Would it be worth a separate repo, or should it stay in this package?

**Deliverable:** 1-page summary with recommendation (yes/no/when) + link to relevant contracts if found.

- [ ] **Step 1: Researcher investigates**

Use web search + GitHub search to find existing generic multicall Solidity implementations. Check: Lens Protocol, OpenZeppelin, Gnosis, Yearn, Morpho.

- [ ] **Step 2: Researcher writes summary**

Save to: `/home/pkl/workspace/research/2026-05-31-solidity-generic-multicall-research.md`

- [ ] **Step 3: Researcher commits**

```bash
git add -A && git commit -m "docs: research — generic Solidity MultistepMulticall viability"
```

---

## Task Graph

```
T1 (scaffold refactor: core types + StepExecutor interface)
T2 (viem engine + tests)
T3 (ethers v6 engine + tests)
T4 (ethers v5 engine + tests)
T5 (extract shared handlers — refactor all 3 engines)
T6 (build verification + index.ts)
T7 (tree-shaking tests + minification) ← ts-dev
T8 (Solidity generic contract research) ← researcher
```

T2, T3, T4 can run in parallel after T1 is done.
T5 depends on T2+T3+T4.
T6 depends on T5.
T7 depends on T6.
T8 is independent — runs in parallel with all others.
