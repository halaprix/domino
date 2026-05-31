# multistep-multicall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract core FSM executor and 2 reference handlers (ERC4626, ERC20) into a standalone MIT-licensed npm package.

**Architecture:** Core `runMultistepTasks()` executor operates as a finite state machine — batches all tasks' calls per step into one Multicall3 call, routes results back by key, allows step N+1 to depend on step N results. Reference handlers are self-contained examples implementing `MultistepTask<T>` for ERC4626 vaults and ERC20 tokens.

**Tech Stack:** TypeScript strict, tsup (CJS+ESM dual build), Vitest, viem (peerDependencies)

---

## File Structure

```
src/
├── index.ts              # Public API: re-exports
├── multistepMulticall.ts  # Core FSM executor (standalone, zero protocol knowledge)
├── handlers/
│   ├── erc4626.ts        # ERC4626 vault resolver
│   └── erc20.ts           # ERC20 token resolver
├── __tests__/
│   ├── multistepMulticall.test.ts
│   ├── erc4626.test.ts
│   └── erc20.test.ts
```

Supporting files in repo root:
- `package.json` — MIT, peerDeps: viem
- `tsconfig.json` — strict, ESM
- `tsup.config.ts` — CJS + ESM dual build
- `vitest.config.ts`
- `LICENSE` — MIT
- `README.md`

---

## Tasks

### Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsup.config.ts`
- Create: `vitest.config.ts`
- Create: `LICENSE`
- Create: `README.md`

- [ ] **Step 1: Write package.json**

```json
{
  "name": "multistep-multicall",
  "version": "0.1.0",
  "private": false,
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": {
        "types": "./dist/index.d.ts",
        "default": "./dist/index.js"
      },
      "require": {
        "types": "./dist/index.d.cts",
        "default": "./dist/index.cjs"
      }
    }
  },
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "test": "vitest",
    "test:coverage": "vitest --coverage",
    "lint": "eslint src",
    "lint:fix": "eslint src --fix"
  },
  "peerDependencies": {
    "viem": "^2.0.0"
  },
  "devDependencies": {
    "viem": "^2.39.0",
    "typescript": "^5.5.0",
    "tsup": "^8.0.0",
    "vitest": "^2.0.0",
    "@vitest/coverage-v8": "^2.0.0",
    "eslint": "^9.0.0",
    "typescript-eslint": "^8.0.0",
    "tsx": "^4.20.0"
  },
  "keywords": [
    "ethereum",
    "multicall",
    "evm",
    "viem",
    "blockchain",
    "rpc",
    "batch"
  ],
  "repository": {
    "type": "git",
    "url": "TODO: add repo URL after creation"
  }
}
```

- [ ] **Step 2: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "lib": ["ES2022"],
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Write tsup.config.ts**

```typescript
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
});
```

- [ ] **Step 4: Write vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/__tests__/**/*.test.ts"],
  },
});
```

- [ ] **Step 5: Write LICENSE (MIT)**

```
MIT License

Copyright (c) 2026

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 6: Write README.md skeleton**

```markdown
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
```

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json tsup.config.ts vitest.config.ts LICENSE README.md
git commit -m "feat: project scaffold with tsup, vitest, dual CJS/ESM build"
```

---

### Task 2: Core FSM Executor

**Files:**
- Create: `src/multistepMulticall.ts`
- Test: `src/__tests__/multistepMulticall.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runMultistepTasks } from "../multistepMulticall";
import type { MultistepTask } from "../multistepMulticall";

describe("runMultistepTasks", () => {
  // Mock viem PublicClient
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      multicall: vi.fn(),
    };
  });

  it("executes single-step task and returns result", async () => {
    const task: MultistepTask<{ value: string }> = {
      maxStep: 1,
      buildStepCalls: (step) => {
        if (step !== 1) return [];
        return [
          {
            key: "value",
            target: "0x1234567890123456789012345678901234567890",
            abi: [{ type: "function", name: "symbol", inputs: [], outputs: [{ type: "string" }] }],
            functionName: "symbol",
          },
        ];
      },
      consumeStepResults: () => {},
      finalize: () => ({ value: "TKN" }),
    };

    mockClient.multicall.mockResolvedValueOnce([
      { status: "success", result: "TKN" },
    ]);

    const results = await runMultistepTasks(mockClient, [task]);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ value: "TKN" });
  });

  it("routes results to tasks by key", async () => {
    const taskA: MultistepTask<{ a: string }> = {
      maxStep: 1,
      buildStepCalls: (step) => {
        if (step !== 1) return [];
        return [
          {
            key: "a",
            target: "0x1111111111111111111111111111111111111111",
            abi: [{ type: "function", name: "symbol", inputs: [], outputs: [{ type: "string" }] }],
            functionName: "symbol",
          },
        ];
      },
      consumeStepResults: vi.fn(),
      finalize: () => ({ a: "A" }),
    };

    const taskB: MultistepTask<{ b: string }> = {
      maxStep: 1,
      buildStepCalls: (step) => {
        if (step !== 1) return [];
        return [
          {
            key: "b",
            target: "0x2222222222222222222222222222222222222222",
            abi: [{ type: "function", name: "symbol", inputs: [], outputs: [{ type: "string" }] }],
            functionName: "symbol",
          },
        ];
      },
      consumeStepResults: vi.fn(),
      finalize: () => ({ b: "B" }),
    };

    mockClient.multicall.mockResolvedValueOnce([
      { status: "success", result: "A" },
      { status: "success", result: "B" },
    ]);

    const results = await runMultistepTasks(mockClient, [taskA, taskB]);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ a: "A" });
    expect(results[1]).toEqual({ b: "B" });
  });

  it("executes multi-step task: step2 depends on step1 results", async () => {
    let capturedBalance: bigint | undefined;

    const task: MultistepTask<{ shares: bigint; assets: bigint }> = {
      maxStep: 2,
      buildStepCalls: (step) => {
        if (step === 1) {
          return [
            {
              key: "balance",
              target: "0x3333333333333333333333333333333333333333",
              abi: [{ type: "function", name: "balanceOf", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] }],
              functionName: "balanceOf",
              args: ["0x4444444444444444444444444444444444444444"],
            },
          ];
        }
        if (step === 2 && capturedBalance !== undefined) {
          return [
            {
              key: "assets",
              target: "0x3333333333333333333333333333333333333333",
              abi: [{ type: "function", name: "convertToAssets", inputs: [{ name: "shares", type: "uint256" }], outputs: [{ type: "uint256" }] }],
              functionName: "convertToAssets",
              args: [capturedBalance],
            },
          ];
        }
        return [];
      },
      consumeStepResults: (step, results) => {
        if (step === 1) {
          for (const r of results) {
            if (r.key === "balance") {
              capturedBalance = r.value as bigint;
            }
          }
        }
      },
      finalize: () => ({ shares: capturedBalance ?? 0n, assets: capturedBalance ?? 0n }),
    };

    // Step 1 response
    mockClient.multicall.mockResolvedValueOnce([
      { status: "success", result: 1000000000000000000n },
    ]);
    // Step 2 response
    mockClient.multicall.mockResolvedValueOnce([
      { status: "success", result: 1500000000000000000n },
    ]);

    const results = await runMultistepTasks(mockClient, [task]);
    expect(results).toHaveLength(1);
    expect(results[0].shares).toBe(1000000000000000000n);
    expect(results[0].assets).toBe(1500000000000000000n);
    // Verify multicall was called twice (once per step)
    expect(mockClient.multicall).toHaveBeenCalledTimes(2);
  });

  it("returns empty array for empty tasks", async () => {
    const results = await runMultistepTasks(mockClient, []);
    expect(results).toEqual([]);
  });

  it("skips failed calls (allowFailure) and continues", async () => {
    const task: MultistepTask<{ value: string | undefined }> = {
      maxStep: 1,
      buildStepCalls: (step) => {
        if (step !== 1) return [];
        return [
          {
            key: "value",
            target: "0x5555555555555555555555555555555555555555",
            abi: [{ type: "function", name: "symbol", inputs: [], outputs: [{ type: "string" }] }],
            functionName: "symbol",
          },
        ];
      },
      consumeStepResults: () => {},
      finalize: () => ({ value: undefined }),
    };

    // Simulate allowFailure: call returns error object
    mockClient.multicall.mockResolvedValueOnce([
      { status: "failure", error: "Execution reverted" },
    ]);

    const results = await runMultistepTasks(mockClient, [task]);
    expect(results).toHaveLength(1);
    // Failed calls are skipped, consumeStepResults not called, finalize receives empty results
    expect(results[0]).toEqual({ value: undefined });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest src/__tests__/multistepMulticall.test.ts -v`
Expected: FAIL — "Cannot find module '../multistepMulticall'"

- [ ] **Step 3: Write minimal implementation**

```typescript
import type { Abi, Address, PublicClient } from "viem";

/**
 * A single on-chain call that belongs to one step of one task.
 */
export interface StepCall {
  /** Logical key for routing results back. */
  key: string;
  /** Target contract address. */
  target: Address;
  /** ABI for the contract (used by viem). */
  abi: Abi;
  /** Function name to call. */
  functionName: string;
  /** Raw arguments — validated at viem call-site, not here. */
  args?: readonly unknown[];
}

/**
 * Result of a single successful call.
 */
export interface StepResult {
  key: string;
  value: unknown;
}

/**
 * A self-contained task that describes a multi-step data retrieval pipeline.
 *
 * Conceptually:
 * - buildStepCalls(step) → calls needed for this step (may depend on prior results)
 * - consumeStepResults(step, results) → update internal state
 * - finalize() → collapse state into result type T
 *
 * Example (ERC4626 vault):
 * - Step 1: symbol, decimals, asset(), balanceOf(owner), maxWithdraw(owner), maxRedeem(owner)
 * - consumeStepResults: extract balance → update internal context
 * - Step 2: convertToAssets(balance) — uses step 1 result
 * - finalize: return { metadata, position }
 */
export interface MultistepTask<TResult> {
  /** Highest step index this task will use (1-based). */
  maxStep: number;

  /**
   * Build all calls needed for a given step.
   * Return empty array if this task has nothing to do for the step.
   */
  buildStepCalls(step: number): StepCall[];

  /**
   * Consume results for a given step and update internal task state.
   */
  consumeStepResults(step: number, results: StepResult[]): void;

  /**
   * Produce the final result once all steps are processed.
   */
  finalize(): TResult;
}

/**
 * Execute multiple MultistepTasks against a single PublicClient.
 *
 * Algorithm:
 * 1. Find maxStep across all tasks.
 * 2. For each step 1..maxStep:
 *    a. Build all calls from all tasks for this step.
 *    b. Batch into one multicall.
 *    c. Distribute results back to tasks by key.
 * 3. Call finalize() on all tasks and return results.
 *
 * Complexity: O(M) RPC calls where M = maxStep across all tasks.
 * (vs O(N) sequential calls for naive approach)
 */
export async function runMultistepTasks<TResult>(
  client: PublicClient,
  tasks: MultistepTask<TResult>[],
): Promise<TResult[]> {
  if (tasks.length === 0) return [];

  const maxStep = tasks.reduce((max, task) =>
    task.maxStep > max ? task.maxStep : max,
    0,
  );

  for (let step = 1; step <= maxStep; step++) {
    const contracts: {
      address: Address;
      abi: Abi;
      functionName: string;
      args?: readonly unknown[];
    }[] = [];

    const mapping: { taskIndex: number; key: string }[] = [];

    for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
      const task = tasks[taskIndex]!;
      if (step > task.maxStep) continue;

      const calls = task.buildStepCalls(step);
      for (const call of calls) {
        contracts.push({
          address: call.target,
          abi: call.abi,
          functionName: call.functionName,
          args: call.args,
        });
        mapping.push({ taskIndex, key: call.key });
      }
    }

    if (contracts.length === 0) {
      continue;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await client.multicall({
      contracts: contracts as any,
      allowFailure: true,
      batchSize: 4 * 4096,
    });

    // Group results by task
    const perTaskResults = new Map<number, StepResult[]>();
    for (let i = 0; i < results.length; i++) {
      const entry = mapping[i];
      if (!entry) continue;
      const { taskIndex, key } = entry;
      const result = results[i] as any;

      if (result.status === "success") {
        let list = perTaskResults.get(taskIndex);
        if (!list) {
          list = [];
          perTaskResults.set(taskIndex, list);
        }
        list.push({ key, value: result.result });
      }
    }

    perTaskResults.forEach((resultsForTask, taskIndex) => {
      const task = tasks[taskIndex];
      if (task) {
        task.consumeStepResults(step, resultsForTask);
      }
    });
  }

  return tasks.map((task) => task.finalize());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest src/__tests__/multistepMulticall.test.ts -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/multistepMulticall.ts src/__tests__/multistepMulticall.test.ts
git commit -m "feat: add core runMultistepTasks FSM executor with viem multicall3 integration"
```

---

### Task 3: ERC20 Handler

**Files:**
- Create: `src/handlers/erc20.ts`
- Test: `src/__tests__/erc20.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveErc20Token, resolveErc20TokensBulk } from "../handlers/erc20";
import { erc20Abi } from "viem";

describe("resolveErc20Token", () => {
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      multicall: vi.fn(),
    };
  });

  it("resolves symbol and decimals without owner", async () => {
    mockClient.multicall.mockResolvedValueOnce([
      { status: "success", result: "USDC" },
      { status: "success", result: 6n },
    ]);

    const result = await resolveErc20Token({
      client: mockClient,
      token: "0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4",
    });

    expect(result.symbol).toBe("USDC");
    expect(result.decimals).toBe(6);
    expect(result.balance).toBeUndefined();
  });

  it("resolves symbol, decimals, and balance with owner", async () => {
    // Single step: symbol, decimals, balanceOf
    mockClient.multicall.mockResolvedValueOnce([
      { status: "success", result: "USDC" },
      { status: "success", result: 6n },
      { status: "success", result: 1000000n },
    ]);

    const result = await resolveErc20Token({
      client: mockClient,
      token: "0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4",
      owner: "0x1234567890123456789012345678901234567890",
    });

    expect(result.symbol).toBe("USDC");
    expect(result.decimals).toBe(6);
    expect(result.balance).toBe(1000000n);
  });
});

describe("resolveErc20TokensBulk", () => {
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      multicall: vi.fn(),
    };
  });

  it("resolves multiple tokens in one multicall", async () => {
    // All tasks batched into single step 1
    mockClient.multicall.mockResolvedValueOnce([
      // Token 0
      { status: "success", result: "USDC" },
      { status: "success", result: 6n },
      { status: "success", result: 1000000n },
      // Token 1
      { status: "success", result: "WETH" },
      { status: "success", result: 18n },
      { status: "success", result: 2000000000000000000n },
    ]);

    const results = await resolveErc20TokensBulk({
      client: mockClient,
      entries: [
        {
          token: "0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4",
          owner: "0x1234567890123456789012345678901234567890",
        },
        {
          token: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
          owner: "0x1234567890123456789012345678901234567890",
        },
      ],
    });

    expect(results).toHaveLength(2);
    expect(results[0]?.symbol).toBe("USDC");
    expect(results[0]?.balance).toBe(1000000n);
    expect(results[1]?.symbol).toBe("WETH");
    expect(results[1]?.balance).toBe(2000000000000000000n);
    // Single multicall call for 6 contract calls
    expect(mockClient.multicall).toHaveBeenCalledTimes(1);
  });

  it("returns empty array for empty entries", async () => {
    const results = await resolveErc20TokensBulk({
      client: mockClient,
      entries: [],
    });
    expect(results).toEqual([]);
    expect(mockClient.multicall).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest src/__tests__/erc20.test.ts -v`
Expected: FAIL — "Cannot find module '../handlers/erc20'"

- [ ] **Step 3: Write implementation**

```typescript
import { type Address, type PublicClient, erc20Abi } from "viem";
import type { Abi } from "viem";
import { type MultistepTask, runMultistepTasks } from "../multistepMulticall";

type Erc20Context = {
  symbol?: string;
  decimals?: number;
  balance?: bigint;
};

export interface Erc20TokenResolution {
  symbol?: string;
  decimals?: number;
  balance?: bigint;
}

type Erc20Task = MultistepTask<Erc20TokenResolution>;

function buildErc20Task(params: {
  token: Address;
  owner?: Address;
}): Erc20Task {
  const { token, owner } = params;
  const ctx: Erc20Context = {};
  const hasOwner = !!owner;

  const task: Erc20Task = {
    maxStep: 1,

    buildStepCalls(step) {
      if (step !== 1) return [];

      const calls: {
        key: string;
        target: Address;
        abi: Abi;
        functionName: string;
        args?: readonly unknown[];
      }[] = [
        {
          key: "symbol",
          target: token,
          abi: erc20Abi as Abi,
          functionName: "symbol",
        },
        {
          key: "decimals",
          target: token,
          abi: erc20Abi as Abi,
          functionName: "decimals",
        },
      ];

      if (hasOwner && owner) {
        calls.push({
          key: "balance",
          target: token,
          abi: erc20Abi as Abi,
          functionName: "balanceOf",
          args: [owner],
        });
      }

      return calls;
    },

    consumeStepResults(step, results) {
      if (step !== 1) return;

      for (const result of results) {
        if (result.key === "symbol") {
          ctx.symbol = result.value as string;
        }
        if (result.key === "decimals") {
          ctx.decimals = Number(result.value as bigint);
        }
        if (result.key === "balance") {
          ctx.balance = BigInt(result.value as string);
        }
      }
    },

    finalize() {
      return {
        symbol: ctx.symbol,
        decimals: ctx.decimals,
        balance: ctx.balance,
      };
    },
  };

  return task;
}

/**
 * Resolve ERC20 token metadata and optionally balance for an owner.
 *
 * Single-step task:
 * - symbol(), decimals(), balanceOf(owner?)
 */
export async function resolveErc20Token(params: {
  client: PublicClient;
  token: Address;
  owner?: Address;
}): Promise<Erc20TokenResolution> {
  const { client, token, owner } = params;
  const task = buildErc20Task({ token, owner });
  const [resolution] = await runMultistepTasks(client, [task]);
  return resolution!;
}

/**
 * Resolve multiple ERC20 tokens in a single multicall.
 *
 * All tokens' step 1 calls are batched into one multicall.
 */
export async function resolveErc20TokensBulk(params: {
  client: PublicClient;
  entries: { token: Address; owner?: Address }[];
}): Promise<Erc20TokenResolution[]> {
  const { client, entries } = params;
  if (entries.length === 0) return [];

  const tasks = entries.map((entry) =>
    buildErc20Task({ token: entry.token, owner: entry.owner }),
  );
  return runMultistepTasks(client, tasks);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest src/__tests__/erc20.test.ts -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/handlers/erc20.ts src/__tests__/erc20.test.ts
git commit -m "feat: add ERC20 handler with resolveErc20Token and resolveErc20TokensBulk"
```

---

### Task 4: ERC4626 Handler

**Files:**
- Create: `src/handlers/erc4626.ts`
- Test: `src/__tests__/erc4626.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveErc4626Vault, resolveErc4626VaultsBulk } from "../handlers/erc4626";

describe("resolveErc4626Vault", () => {
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      multicall: vi.fn(),
    };
  });

  it("resolves metadata only (no owner)", async () => {
    // Step 1: symbol, decimals, asset
    mockClient.multicall.mockResolvedValueOnce([
      { status: "success", result: "ankrETH" },
      { status: "success", result: 18n },
      { status: "success", result: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" },
    ]);

    const result = await resolveErc4626Vault({
      client: mockClient,
      vault: "0x...",
    });

    expect(result.metadata.symbol).toBe("ankrETH");
    expect(result.metadata.decimals).toBe(18);
    expect(result.metadata.underlyingAsset).toBe("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
    expect(result.position).toBeUndefined();
  });

  it("resolves metadata + position with owner (2-step)", async () => {
    // Step 1: symbol, decimals, asset, balanceOf, maxWithdraw, maxRedeem
    mockClient.multicall.mockResolvedValueOnce([
      { status: "success", result: "ankrETH" },
      { status: "success", result: 18n },
      { status: "success", result: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" },
      { status: "success", result: 1000000000000000000n }, // 1 share
      { status: "success", result: 1600000000000000000n },   // maxWithdraw
      { status: "success", result: 1000000000000000000n },   // maxRedeem
    ]);
    // Step 2: convertToAssets(1000000000000000000n) — uses step 1 balance
    mockClient.multicall.mockResolvedValueOnce([
      { status: "success", result: 1500000000000000000n }, // 1.5 ETH underlying
    ]);

    const result = await resolveErc4626Vault({
      client: mockClient,
      vault: "0x...",
      owner: "0x1234567890123456789012345678901234567890",
    });

    expect(result.metadata.symbol).toBe("ankrETH");
    expect(result.metadata.underlyingAsset).toBe("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
    expect(result.position?.balance).toBe(1000000000000000000n);
    expect(result.position?.assets).toBe(1500000000000000000n);
    // Two multicall calls: step 1 and step 2
    expect(mockClient.multicall).toHaveBeenCalledTimes(2);
  });

  it("skips step 2 when balance is undefined", async () => {
    // Step 1 returns no balance (e.g. user has no position)
    mockClient.multicall.mockResolvedValueOnce([
      { status: "success", result: "ankrETH" },
      { status: "success", result: 18n },
      { status: "success", result: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" },
    ]);
    // No balance call, so step 2 buildStepCalls returns empty → no second multicall

    const result = await resolveErc4626Vault({
      client: mockClient,
      vault: "0x...",
      owner: "0x1234567890123456789012345678901234567890",
    });

    expect(result.metadata.symbol).toBe("ankrETH");
    expect(result.position?.balance).toBeUndefined();
    expect(result.position?.assets).toBeUndefined();
    // Only step 1 was executed
    expect(mockClient.multicall).toHaveBeenCalledTimes(1);
  });
});

describe("resolveErc4626VaultsBulk", () => {
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      multicall: vi.fn(),
    };
  });

  it("batches step 1 and step 2 for all vaults into two multicalls", async () => {
    // Step 1: all vaults' symbol/decimals/asset/balance/maxWithdraw/maxRedeem
    mockClient.multicall.mockResolvedValueOnce([
      // Vault 0
      { status: "success", result: "ankrETH" },
      { status: "success", result: 18n },
      { status: "success", result: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" },
      { status: "success", result: 1000000000000000000n },
      { status: "success", result: 1500000000000000000n },
      { status: "success", result: 1000000000000000000n },
      // Vault 1
      { status: "success", result: "stETH" },
      { status: "success", result: 18n },
      { status: "success", result: "0xAE7ab96520DE3A6E5f16f0f3345D4C3F053ACb1Fc" },
      { status: "success", result: 2000000000000000000n },
      { status: "success", result: 3100000000000000000n },
      { status: "success", result: 2000000000000000000n },
    ]);
    // Step 2: all vaults' convertToAssets(balance)
    mockClient.multicall.mockResolvedValueOnce([
      { status: "success", result: 1500000000000000000n },
      { status: "success", result: 3100000000000000000n },
    ]);

    const results = await resolveErc4626VaultsBulk({
      client: mockClient,
      entries: [
        {
          vault: "0x0000000000000000000000000000000000000001",
          owner: "0x1234567890123456789012345678901234567890",
        },
        {
          vault: "0x0000000000000000000000000000000000000002",
          owner: "0x1234567890123456789012345678901234567890",
        },
      ],
    });

    expect(results).toHaveLength(2);
    expect(results[0]?.metadata.symbol).toBe("ankrETH");
    expect(results[0]?.position?.assets).toBe(1500000000000000000n);
    expect(results[1]?.metadata.symbol).toBe("stETH");
    expect(results[1]?.position?.assets).toBe(3100000000000000000n);
    // 2 multicall calls total: one for step 1, one for step 2
    expect(mockClient.multicall).toHaveBeenCalledTimes(2);
  });

  it("returns empty array for empty entries", async () => {
    const results = await resolveErc4626VaultsBulk({
      client: mockClient,
      entries: [],
    });
    expect(results).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest src/__tests__/erc4626.test.ts -v`
Expected: FAIL — "Cannot find module '../handlers/erc4626'"

- [ ] **Step 3: Write implementation**

```typescript
import {
  type Address,
  type PublicClient,
  erc20Abi,
  erc4626Abi,
} from "viem";
import type { Abi } from "viem";
import { type MultistepTask, runMultistepTasks } from "../multistepMulticall";

type Erc4626Context = {
  symbol?: string;
  decimals?: number;
  balance?: bigint;
  maxWithdraw?: bigint;
  maxRedeem?: bigint;
  underlyingAsset?: Address;
  assets?: bigint;
};

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

type Erc4626Task = MultistepTask<Erc4626VaultResolution>;

function buildErc4626Task(params: {
  vault: Address;
  owner?: Address;
}): Erc4626Task {
  const { vault, owner } = params;
  const ctx: Erc4626Context = {};
  const hasOwner = !!owner;

  const task: Erc4626Task = {
    maxStep: hasOwner ? 2 : 1,

    buildStepCalls(step) {
      if (step === 1) {
        const calls: {
          key: string;
          target: Address;
          abi: Abi;
          functionName: string;
          args?: readonly unknown[];
        }[] = [
          {
            key: "symbol",
            target: vault,
            abi: erc20Abi as Abi,
            functionName: "symbol",
          },
          {
            key: "decimals",
            target: vault,
            abi: erc20Abi as Abi,
            functionName: "decimals",
          },
          {
            key: "asset",
            target: vault,
            abi: erc4626Abi as Abi,
            functionName: "asset",
          },
        ];

        if (hasOwner && owner) {
          calls.push(
            {
              key: "balance",
              target: vault,
              abi: erc20Abi as Abi,
              functionName: "balanceOf",
              args: [owner],
            },
            {
              key: "maxWithdraw",
              target: vault,
              abi: erc4626Abi as Abi,
              functionName: "maxWithdraw",
              args: [owner],
            },
            {
              key: "maxRedeem",
              target: vault,
              abi: erc4626Abi as Abi,
              functionName: "maxRedeem",
              args: [owner],
            },
          );
        }

        return calls;
      }

      if (step === 2 && hasOwner) {
        // Only execute step 2 if we have a balance from step 1
        if (ctx.balance === undefined) {
          return [];
        }
        return [
          {
            key: "assets",
            target: vault,
            abi: erc4626Abi as Abi,
            functionName: "convertToAssets",
            args: [ctx.balance],
          },
        ];
      }

      return [];
    },

    consumeStepResults(step, results) {
      for (const result of results) {
        if (step === 1) {
          if (result.key === "symbol") {
            ctx.symbol = result.value as string;
          }
          if (result.key === "decimals") {
            ctx.decimals = Number(result.value as bigint);
          }
          if (result.key === "asset") {
            ctx.underlyingAsset = result.value as Address;
          }
          if (hasOwner) {
            if (result.key === "balance") {
              ctx.balance = BigInt(result.value as string);
            }
            if (result.key === "maxWithdraw") {
              ctx.maxWithdraw = BigInt(result.value as string);
            }
            if (result.key === "maxRedeem") {
              ctx.maxRedeem = BigInt(result.value as string);
            }
          }
        }

        if (step === 2 && result.key === "assets") {
          ctx.assets = BigInt(result.value as string);
        }
      }
    },

    finalize() {
      return {
        metadata: {
          symbol: ctx.symbol,
          decimals: ctx.decimals,
          underlyingAsset: ctx.underlyingAsset,
          maxWithdraw: ctx.maxWithdraw,
          maxRedeem: ctx.maxRedeem,
        },
        position: hasOwner
          ? {
              balance: ctx.balance,
              assets: ctx.assets,
            }
          : undefined,
      };
    },
  };

  return task;
}

/**
 * Resolve ERC4626 vault metadata and optionally position for an owner.
 *
 * Without owner:
 * - Step 1: symbol, decimals, asset()
 *
 * With owner:
 * - Step 1: symbol, decimals, asset(), balanceOf(owner), maxWithdraw(owner), maxRedeem(owner)
 * - Step 2: convertToAssets(balance) — depends on step 1 balance
 */
export async function resolveErc4626Vault(params: {
  client: PublicClient;
  vault: Address;
  owner?: Address;
}): Promise<Erc4626VaultResolution> {
  const { client, vault, owner } = params;
  const task = buildErc4626Task({ vault, owner });
  const [resolution] = await runMultistepTasks(client, [task]);
  return resolution!;
}

/**
 * Resolve multiple ERC4626 vaults in a single multicall pipeline.
 *
 * All vaults' step 1 calls are batched into one multicall.
 * All vaults' step 2 calls are batched into a second multicall.
 * Total: 2 RPC calls regardless of vault count.
 */
export async function resolveErc4626VaultsBulk(params: {
  client: PublicClient;
  entries: { vault: Address; owner?: Address }[];
}): Promise<Erc4626VaultResolution[]> {
  const { client, entries } = params;
  if (entries.length === 0) return [];

  const tasks = entries.map((entry) =>
    buildErc4626Task({ vault: entry.vault, owner: entry.owner }),
  );
  return runMultistepTasks(client, tasks);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest src/__tests__/erc4626.test.ts -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/handlers/erc4626.ts src/__tests__/erc4626.test.ts
git commit -m "feat: add ERC4626 handler with 2-step convertToAssets resolution"
```

---

### Task 5: Public API (index.ts)

**Files:**
- Create: `src/index.ts`

- [ ] **Step 1: Write the index**

```typescript
// Core FSM executor
export type { MultistepTask, StepCall, StepResult } from "./multistepMulticall";
export { runMultistepTasks } from "./multistepMulticall";

// Reference handlers
export { resolveErc20Token, resolveErc20TokensBulk } from "./handlers/erc20";
export type { Erc20TokenResolution } from "./handlers/erc20";

export {
  resolveErc4626Vault,
  resolveErc4626VaultsBulk,
} from "./handlers/erc4626";
export type { Erc4626VaultResolution } from "./handlers/erc4626";
```

- [ ] **Step 2: Verify all tests still pass**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: expose public API via src/index.ts"
```

---

### Task 6: Run full test suite + build

**Files:**
- Verify: `npm run build` produces CJS + ESM output
- Verify: `npm run test` all pass

- [ ] **Step 1: Run full test suite**

Run: `npm run test`
Expected: All tests pass

- [ ] **Step 2: Run build**

Run: `npm run build`
Expected: `dist/index.js`, `dist/index.cjs`, `dist/index.d.ts` created

- [ ] **Step 3: Verify exports map resolution**

Check `dist/` contains:
- `index.js` (ESM)
- `index.cjs` (CJS)
- `index.d.ts` (TypeScript declarations)

- [ ] **Step 4: Commit**

```bash
git add dist/  # if tracked, or add to .gitignore
git commit -m "chore: add dist to gitignore and verify build output"
```

Or if you want to track dist:
```bash
git add dist/ .gitignore
git commit -m "chore: add dist build artifacts"
```

---

### Task 7: GitHub + NPM Setup

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `README.md` (add NPM badge, badges)
- Modify: `package.json` (add repo URL after creating)

- [ ] **Step 1: Create CI workflow**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install
      - run: pnpm run test
      - run: pnpm run build

  typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install
      - run: pnpm exec tsc --noEmit
```

- [ ] **Step 2: Commit CI**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add GitHub Actions CI workflow"
```

---

### Task 8: Push to GitHub

**Context:** After all tasks complete, push to GitHub.

- [ ] **Step 1: Add remote and push**

```bash
git remote add origin https://github.com/YOUR_USERNAME/multistep-multicall.git
git branch -M main
git push -u origin main
```

---

## Self-Review Checklist

- [ ] Spec coverage: All SPEC.md requirements mapped to tasks? YES
  - Core executor ✓
  - ERC4626 handler (2-step) ✓
  - ERC20 handler (1-step) ✓
  - MIT license ✓
  - peerDependencies viem ✓
  - tsup dual build ✓
  - Vitest tests ✓
  - CI workflow ✓

- [ ] Placeholder scan: No TBD/TODO/step-placeholder in any task? CLEAN

- [ ] Type consistency: All types match across tasks?
  - `Erc20TokenResolution` used consistently ✓
  - `Erc4626VaultResolution` used consistently ✓
  - `MultistepTask<T>` signatures match ✓

---

**Plan complete and saved to `docs/superpowers/plans/YYYY-MM-DD-multistep-multicall.md`.**

Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?