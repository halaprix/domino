# API Reference

Complete reference for `@halaprix/domino`. For a quick introduction see the [README](../README.md); for bundle size data and comparisons see [Benchmarks](benchmarks.md).

## Architecture

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
│    b. executeMulticall() — one RPC per step batch   │
│       (≤ batchSize calls)                           │
│    c. consumeStepResults() — distribute to tasks    │
│  • finalize() — assemble results                    │
└──────────────────────┬──────────────────────────────┘
                       │
          ┌────────────▼────────────┐
          │  Multicall3 (deployed)  │
          │  or deployless (CREATE) │
          └─────────────────────────┘
```

The FSM runs through all tasks step-by-step:

1. **Collect** all calls for step N from all active tasks
2. **Batch** into a single multicall call (split into multiple physical batches if a step has more than `batchSize` calls)
3. **Route** results back to each task via the `key` field
4. **Repeat** for each step until all tasks are done
5. **Finalize** — each task returns its typed result

Both `defineTask` output and hand-written `MultistepTask` objects are ordinary `MultistepTask`s to the FSM — they can be freely mixed in the same `tasks` array and batched together.

## Atomicity

One physical multicall batch (one `eth_call` against Multicall3, or its deployless fallback) is atomic: every call inside it reads the same EVM state, because the node evaluates the whole batch against a single block. Across separate batches — later steps of the same task, or physical batches split by `batchSize`/`maxConcurrentBatches` within one step — there is **no such guarantee** by default: the chain can advance between round-trips.

Set `pinBlock: true` to remove that gap. The run resolves ONE concrete block at the very start and reuses it for every step and every physical batch for the rest of that `run`/`runSettled` call:

| `block` input | Resolved to | Extra RPC |
|---|---|---|
| absent, or any stable tag (`{ blockTag: 'latest' \| 'earliest' \| 'safe' \| 'finalized' }`) | `executor.getBlockNumber(block)` → `{ blockNumber }`, used for every step | +1 round-trip |
| `{ blockTag: 'pending' }` | throws — `pending` has no stable block number | — |
| `{ blockNumber }` | used as-is | none |
| `{ blockHash, requireCanonical? }` | used as-is, `requireCanonical` untouched | none |

```typescript
import { Eip1193Executor, MulticallResolver, Presets } from "@halaprix/domino"
import type { MultistepTask } from "@halaprix/domino"

declare const executor: Eip1193Executor
declare const tasks: MultistepTask<unknown>[]

const resolver = new MulticallResolver(executor)

await resolver.run(tasks, {
  ...Presets.throughput,
  pinBlock: true,
  onPin: (block) => console.log("pinned to", block),
})
```

`onPin` — when provided — runs synchronously exactly once per run, only when `pinBlock: true`, with the resolved `PinnedBlock`. If it throws, the run rejects with that error; tasks are already marked consumed by that point, and no multicall batch is ever dispatched. `pinBlock: true` against a `StepExecutor` without `getBlockNumber(block?)` throws immediately, before anything is consumed — a custom `StepExecutor` opts into pinning by implementing that one optional method.

## `defineTask` — the recommended way to describe a task

`defineTask(build)` runs `build` exactly once, synchronously, and returns a compiled `MultistepTask` — pass it straight to `runMultistepTasks`, `runSettled`, or `resolver.run()`/`resolver.runSettled()`, batched with any other task (including hand-written `MultistepTask`s, see [below](#legacy-hand-written-multisteptask-definetasks-compilation-target)) exactly like before.

Inside `build`, `t.call(spec)` describes one contract read and returns a `Ref<T>` — an opaque handle to a value that isn't resolved yet. Feed a `Ref` into another call's `args` (or its `target`) to describe a dependency between steps; `defineTask` works out the depth of the resulting graph itself (a node can only reference nodes minted before it, so the graph is a DAG by construction), so there's no `step` number to manage by hand.

```typescript
import { defineTask } from "@halaprix/domino"
import type { Address } from "@halaprix/domino"

declare const vault: Address
declare const owner: Address

const vaultAbi = [
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function asset() view returns (address)",
] as const

const erc20Abi = ["function symbol() view returns (string)"] as const

const task = defineTask((t) => {
  // A typed, ABI-checked call. `functionName` is constrained to view|pure
  // functions of `abi`; `args` is inferred from the ABI (required once the
  // function takes at least one input, omittable for zero-arg functions).
  const balance = t.call({ target: vault, abi: vaultAbi, functionName: "balanceOf", args: [owner] })

  // Feed step 1's Ref<bigint> straight into step 2's args — resolved once
  // `balance`'s own call has run; this call is skipped if `balance` failed.
  const assets = t.call({
    target: vault,
    abi: vaultAbi,
    functionName: "convertToAssets",
    args: [balance],
  })

  // `optional: true` demotes a failed call to `undefined` instead of
  // rejecting the whole task — see runSettled's diagnostics below.
  const underlying = t.call({ target: vault, abi: vaultAbi, functionName: "asset", optional: true })

  // Dynamic target: `underlying` (Ref<Address | undefined>) feeds the
  // TARGET position of another call. Resolved first; this call is skipped
  // automatically if `underlying` failed or resolved to undefined. It is
  // ALSO marked `optional: true` here — a skip-chained failure is still a
  // hard failure unless the consuming call itself opts out of rejecting the
  // task, so keeping an optional chain resilient end-to-end means every
  // link in it needs `optional: true`, not just the first one.
  const underlyingSymbol = t.call({ target: underlying, abi: erc20Abi, functionName: "symbol", optional: true })

  // t.derive computes a value locally from already-resolved Refs — no RPC call.
  const hasBalance = t.derive([balance], (bal) => bal > 0n)

  return { balance, assets, underlying, underlyingSymbol, hasBalance }
})
```

`task`'s inferred result type is `{ balance: bigint; assets: bigint; underlying: Address | undefined; underlyingSymbol: string | undefined; hasBalance: boolean }` — `ResolveRefs<S>` walks the shape your builder returns and swaps every `Ref<T>` leaf for `T`, recursively through plain objects, arrays, and tuples. (Had `underlyingSymbol` above been left non-optional, it would still type-check — `Ref<string>`, not `Ref<string | undefined>` — but the *task* would reject whenever `underlying` failed: a skip-chained failure into a non-optional call is a hard failure, not a graceful `undefined`.) See [`ResolveRefs`: type vs. runtime on class instances](#resolverefs-type-vs-runtime-on-class-instances) below for the one case `ResolveRefs` and `finalize()` disagree on.

### `t.call` — `TypedCallSpec` fields

| Field | Type | Notes |
|---|---|---|
| `target` | `Address \| Ref<Address \| undefined>` | A literal address, or another call's `Ref` for a dynamic target. |
| `abi` | `Abi \| readonly string[]` | Parsed ABI (object form) or human-readable strings (e.g. `["function symbol() view returns (string)"]`) — both infer identically. String arrays are normalized to a parsed `Abi` at build time and memoized (`parseAbiMemoized`, WeakMap identity cache + value-equality LRU), so repeated identical fragments across calls don't re-parse. Arrays must be entirely strings or entirely parsed ABI items — a mix throws at build time. |
| `functionName` | a view/pure function name of `abi` | Non-view/pure names (e.g. `transfer`) are a type error — only reads are expressible through `t.call`. |
| `args` | tuple inferred from `abi`/`functionName` | Each position accepts a literal value or a `Ref` of the same type. Required once the function takes ≥1 input; omittable for zero-arg functions. |
| `optional` | `boolean` | `true` widens the returned ref to `Ref<T \| undefined>`: a failed call resolves to `undefined` instead of rejecting the task. Must be a literal `true`/`false` — a widened `boolean` variable matches neither `call` overload (narrow it first). |
| `dedupe` | `boolean` | Accepted and stored today (default: eligible, i.e. `true`). Nothing reads it yet — reserved for the upcoming call-deduplication feature; every call executes regardless of this flag until then. |

### `t.derive` — local computation over resolved `Ref`s

```typescript
import type { Ref, ResolveRefs } from "@halaprix/domino"

interface TaskBuilderDerive {
  derive<const I extends readonly Ref<unknown>[], R>(
    inputs: I,
    fn: (...values: ResolveRefs<I>) => R,
  ): Ref<R>
}
```

`fn` runs at most once, lazily, the first time its result is actually needed (cached after — it is never re-run). It never issues an RPC call; use it to combine/transform values already produced by `t.call`. If any (non-optional) input `Ref` failed, `fn` never runs and the derive's own `Ref` fails with `kind: 'skipped'` (`cause` = the upstream error). If an input was `optional` and failed, `fn` still runs and receives `undefined` for that position. If `fn` itself throws, the derive's `Ref` fails with `kind: 'derive'` (`cause` = the thrown value).

### `Ref<T>` and dynamic targets

`Ref<T>` is opaque — there is no way to construct one directly or read its value out; the only way to get a real value is to return it from the builder callback and let `finalize()` resolve it. `WithRefs<T>` is what makes a `Ref` assignable at every `args` tuple position (`element | Ref<element | undefined>`), and `target` accepts `Address | Ref<Address | undefined>` for the same reason — so an `optional: true` call's ref can feed a dynamic target, and the runtime's skip-chain rule (above) handles an actual `undefined` resolution.

### `ResolveRefs`: type vs. runtime on class instances

`ResolveRefs<S>` walks the shape your builder returns and swaps every `Ref<T>` leaf for `T`, recursively through plain objects, arrays, and tuples — **and, at the type level, through class instance types too**, since a mapped type (`{ [K in keyof S]: ResolveRefs<S[K]> }`) is purely structural and doesn't distinguish a class instance's type from a plain object's:

```typescript
import type { Ref, ResolveRefs } from "@halaprix/domino"

class Box<T> {
  constructor(public value: T) {}
}

// Resolved is { value: bigint } — the TYPE-level mapping descends into
// Box's field and unwraps the Ref, same as it would for a plain object.
type Resolved = ResolveRefs<Box<Ref<bigint>>>
```

The **runtime** does not follow the type this far. `finalize()`'s actual resolution (`resShape`) only recurses into arrays and genuinely plain objects (prototype `Object.prototype` or `null`) — for anything else (a class instance, a `Map`, a `Date`, …) it does not resolve at all. Instead it runs one shallow safety check: if any of that object's own top-level enumerable properties is itself a `Ref`, it throws (`"Refs inside class instances/non-plain objects are not supported in the returned shape — use plain objects/arrays"`) rather than silently returning an unresolved ref. So returning `new Box(someRef)` directly from the builder throws at `finalize()` time, even though `ResolveRefs<Box<Ref<T>>>` type-checks as `{ value: T }`.

That shallow check only catches a `Ref` at the object's *own* top level — a `Ref` nested two or more levels deep inside a non-plain object (e.g. `new Box({ inner: someRef })`) is not detected by either the type or the runtime check, and silently passes through with the ref unresolved. Return refs through plain objects/arrays/tuples instead of class instances to avoid both failure modes.

### Single-use contract

`defineTask`'s output — like `buildErc20Task`/`buildErc4626Task` output — is single-run: submitting the same instance to `runMultistepTasks`/`runSettled` a second time (as a fresh call, or twice in the same `tasks` array) throws `DominoTaskReuseError`. Write factories (a function that returns a fresh `defineTask(...)` per call) and call them fresh per run. A zero-call (derive-only) task is marked consumed the moment it's accepted into a run — even though the executor is never invoked for it — so it can't be reused just because it never made an RPC call. Hand-written `MultistepTask` objects are never branded this way; they keep 1.0 behavior (reusable if you keep them stateless).

## Legacy: hand-written `MultistepTask` (`defineTask`'s compilation target)

`defineTask` output *is* a `MultistepTask` — the exact same `buildStepCalls`/`consumeStepResults`/`finalize` shape you can write by hand. Writing one directly is still fully supported — it's the escape hatch for step gating or result routing the ref-graph builder can't express (yet), and it's what every built-in handler (`buildErc20Task`, `buildErc4626Task`) is written as under the hood:

```typescript
import { runMultistepTasks } from "@halaprix/domino"
import type { StepCall, StepResult, MultistepTask, StepExecutor, Address } from "@halaprix/domino"

declare const executor: StepExecutor

interface MyResult {
  balance: bigint | undefined
}

// Minimal ERC20 balanceOf ABI
const balanceOfAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const

// Use closure to store context across steps
const ctx: { balance?: bigint } = {}

const myTask: MultistepTask<MyResult> = {
  maxStep: 1,

  buildStepCalls(step) {
    if (step !== 1) return []
    return [
      {
        key: "balance",
        target: "0x1111111111111111111111111111111111111111" as Address,
        abi: balanceOfAbi,
        functionName: "balanceOf",
        args: ["0x2222222222222222222222222222222222222222" as Address],
      },
    ]
  },

  consumeStepResults(step, results) {
    for (const result of results) {
      if (result.status === "failure") continue
      if (result.key === "balance" && typeof result.value === "bigint") {
        ctx.balance = result.value
      }
    }
  },

  finalize() {
    return { balance: ctx.balance }
  },
}

const [result] = await runMultistepTasks(executor, [myTask])
```

Unlike `defineTask` output, a hand-written `MultistepTask` like `myTask` is **not** single-use by default — it's plain data, reusable across runs if you keep it stateless (as the compat suite pins: passing the same stateless legacy task twice in one array, or across two separate calls, never throws).

## `runSettled` — per-task settlement

`run()` (`runMultistepTasks`) throws on the first irrecoverable batch failure or the first `finalize()` throw — a single bad task, or a single bad batch, aborts the whole call. `runSettled` isolates failures instead: every task gets its own `SettledTaskResult`, and one task's failure never prevents its siblings from completing.

```typescript
import { runSettled } from "@halaprix/domino"
import type { MultistepTask, StepExecutor } from "@halaprix/domino"

declare const executor: StepExecutor
declare const tasks: MultistepTask<{ a: number }>[]

const settled = await runSettled(executor, tasks)
for (const s of settled) {
  if (s.status === 'fulfilled') {
    console.log(s.value, s.diagnostics.optionalFailures)
  } else {
    console.log('rejected:', s.error)
  }
}
```

### `SettledTaskResult<T>` and `TaskDiagnostics`

```typescript
import type { Address, DominoCallError } from "@halaprix/domino"

interface TaskDiagnostics {
  optionalFailures: Array<{ target?: Address; functionName?: string; error: DominoCallError }>
}

type SettledTaskResult<T> =
  | { status: 'fulfilled'; value: T; diagnostics: TaskDiagnostics }
  | { status: 'rejected'; error: unknown; diagnostics: TaskDiagnostics }
```

Always present on both branches — never optional, even when empty (`{ optionalFailures: [] }`). `optionalFailures` records every `DominoCallError` for a `t.call({ ..., optional: true })` that was demoted to `undefined` instead of rejecting the task. Populated only for `defineTask` output; always `[]` for hand-written `MultistepTask`s, which have no diagnostics channel to read.

### Rejection rules

- **`defineTask` output:** rejected iff a failed, non-optional `Ref` is *reachable* from the shape your builder returned — an unused failed `Ref` (never read by the returned shape) does not reject the task. A `t.derive` whose function throws rejects with `kind: 'derive'`; a call skip-chained from an upstream failure rejects with `kind: 'skipped'`.
- **Hand-written `MultistepTask`:** rejected iff the task's own `buildStepCalls`/`consumeStepResults`/`finalize` throws (the "dead-task rule" — once one of these three throws for a task, no further hooks run for it, and it settles `{ status: 'rejected', error: <thrown value> }`; sibling tasks are unaffected).
- **Programmer errors reject the WHOLE call, not one task's settlement:** an invalid `batchSize`, a reused single-use task (`DominoTaskReuseError`), or a `StepExecutor` that resolves with the wrong number of results for a batch all reject the returned promise itself — none of these produce a `{ status: 'rejected' }` array entry.

### Batch-failure isolation and adaptive bisection

When `executor.executeMulticall` rejects for a physical batch, `runSettled` does not throw. Every call in that batch becomes a failure carrying its own `DominoCallError` (`kind: 'batch'`) — every one of those errors shares the SAME underlying transport error as `cause`, but each call gets its own `DominoCallError` instance. Execution continues: later batches in the same step, and later steps, still run; tasks whose `finalize()` copes with the resulting failures (or `defineTask` tasks where none of the failed calls are reachable from the returned shape) still settle `fulfilled`.

Adaptive bisection (`adaptiveBatching: true`, off by default) automatically splits a failed batch in half and retries both halves independently; rejected regions recurse until they succeed, reach a single call, or exhaust `maxBatchAttempts`, while successful sub-batches are kept immediately. See the [`adaptiveBatching` field](#batching-options) below for when to enable it and its failure semantics.

## Batching Options

`BatchOptions` — passed as the third parameter to `runMultistepTasks(executor, tasks, options)` — controls step batching, concurrency, adaptive isolation, deduplication, block pinning, and error handling. All fields are optional; defaults are shown below.

| Field | Type | Default | Rationale |
|---|---|---|---|
| `batchSize` | `number` | `100` | Batching keeps each aggregate `eth_call` under provider gas/payload/response limits. One very expensive call cannot be fixed by splitting; this parameter splits the logical step, not individual calls. Must be positive. |
| `maxConcurrentBatches` | `number` | `1` | Provider rate limits and executor design typically assume serial execution. Set to >1 only if your provider/executor supports parallelism; `run` fail-fast cancels queued batches, `runSettled` does not. |
| `adaptiveBatching` | `boolean` | `false` | Bisection cannot distinguish a per-call failure (e.g. out-of-gas) from a transient transport problem (e.g. HTTP 429 rate-limiting); under rate-limiting, retries amplify load by up to 2N−1 calls for a single original batch. Enable only when your transport failures are dominated by bad calls, not rate limits; a future failure-cause classification may allow enabling by default. |
| `maxBatchAttempts` | `number` | `2·⌈log₂(batchSize)⌉+1` | Bounds bisection recursion. Default is sized for the common single-bad-call case; batches with multiple failing calls may exhaust it before every one is isolated (producing coarser-grained `kind: 'batch'` failures instead, never wrong data). |
| `dedupe` | `boolean` | `false` | Cross-task call merging changes executor invocation counts seen by instrumentation/billing. Only `TypedCallSpec` calls (from `t.call` in `defineTask`) are ever eligible; legacy tasks are never affected. |
| `block` | `BlockParam` | `{ blockTag: 'latest' }` | Block to query at (EIP-1898). Every step's `executeMulticall` call uses this parameter; without `pinBlock: true`, stable tags like `'latest'` are re-resolved by the node on each separate `eth_call`, so the chain can advance between steps. |
| `pinBlock` | `boolean` | `false` | Resolve one concrete block at run start (+1 RPC) and reuse for every step, closing the "chain advanced between steps" gap. Requires `executor.getBlockNumber()`. |
| `onPin` | `(block: PinnedBlock) => void` | — | Synchronous callback reporting the resolved block (fired exactly once per run when `pinBlock: true`). Only invoked when `pinBlock: true`; supplying it without `pinBlock` is accepted but it is never called. |

See `Presets.throughput` (exports: `{ maxConcurrentBatches: 5, adaptiveBatching: true, dedupe: true }`) for a ready-made bundle suited to portfolio workloads:

```typescript
import { runMultistepTasks, Presets } from "@halaprix/domino"
import type { StepExecutor, MultistepTask } from "@halaprix/domino"

declare const executor: StepExecutor
declare const tasks: MultistepTask<unknown>[]

await runMultistepTasks(executor, tasks, { ...Presets.throughput, batchSize: 200 })
```

## Error taxonomy

`DominoCallError` is the single error type domino constructs for a failed call. `kind` discriminates why the call failed; `data` and `cause` carry different information depending on `kind` — they're separate fields (never conflated) because a decode failure needs both the raw bytes that failed to decode and the decoder exception that explains why:

| `kind` | `data` | `cause` |
|---|---|---|
| `revert` | returnData (revert selector inspectable) | — |
| `decode` | raw bytes that failed to decode | the decode error |
| `batch` | — | provider/transport error |
| `skipped` | — | upstream `DominoCallError` |
| `derive` | — | thrown value |

Only `revert` and `decode` are constructed directly by `Eip1193Executor` (from a real `eth_call` revert or a decode failure). `batch` is constructed by `runSettled` when a physical batch's `executeMulticall` rejects (see above) — a custom `StepExecutor`'s raw error is always preserved as `cause`, never discarded. `skipped` and `derive` are constructed by `defineTask`'s resolution engine (see `t.derive` and the dynamic-target skip-chain rule above).

`DominoCallError` extends the platform `Error`, so `instanceof Error` and the standard `cause` chain (including stack traces) keep working for consumers who don't know about `DominoCallError` specifically.

```typescript
import type { Address } from "@halaprix/domino"

interface DominoCallErrorOptions {
  kind: 'revert' | 'decode' | 'batch' | 'skipped' | 'derive'
  /** Original error/thrown value — preserved via the standard `Error.cause` chain. */
  cause?: unknown
  /** Raw returnData bytes — separate from `cause`; never stuffed into it. */
  data?: `0x${string}`
  /** Target contract address the call was made against. */
  target?: Address
  /** Function name of the call. */
  functionName?: string
  /** Legacy routing key (`StepCall.key` / `StepResult.key`). */
  key?: string
}
```

### `DominoTaskReuseError`

Thrown by `runMultistepTasks`/`runSettled` (and anything that delegates to them, like `MulticallResolver.run`/`runSettled`) when a single-use-branded task (`defineTask`, `buildErc20Task`, or `buildErc4626Task` output) is submitted more than once — either the same instance reused across two separate calls, or the same instance appearing twice in one `tasks` array. Extends `Error` directly, not `DominoCallError` — this is a programmer error (misuse of the task-reuse contract), not an on-chain call failure resolved through the FSM executor. Hand-written `MultistepTask` objects are never branded and never throw this.

## `MulticallResolver` — convenience layer for the built-in handlers

`MulticallResolver` wraps an executor and provides typed convenience methods for ERC20 and ERC4626, plus a generic `run<T>()`/`runSettled<T>()` escape hatch for custom tasks (`defineTask` output or hand-written `MultistepTask`s):

```typescript
import { createPublicClient, http } from "viem"
import { Eip1193Executor, MulticallResolver } from "@halaprix/domino"

// Any viem client works — mainnet, testnet, custom RPC
const provider = createPublicClient({ transport: http() })
const executor = new Eip1193Executor(provider)
const resolver = new MulticallResolver(executor)

const token = await resolver.resolveErc20({
  token: "0x1234567890123456789012345678901234567890" as const,
  owner: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as const,
})

console.log(token.symbol, token.decimals, token.balance)
```

The resolver also supports bulk operations (canonical `resolveErc20Bulk`/`resolveErc4626Bulk` — see [Deprecations](#deprecations) below):

```typescript
import { MulticallResolver } from "@halaprix/domino"

declare const resolver: MulticallResolver

const tokens = await resolver.resolveErc20Bulk({
  entries: [
    { token: "0x1111111111111111111111111111111111111111" as const },
    { token: "0x2222222222222222222222222222222222222222" as const },
  ],
})

const vaults = await resolver.resolveErc4626Bulk({
  entries: [
    { vault: "0x3333333333333333333333333333333333333333" as const, owner: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as const },
  ],
})
```

### Running custom tasks through the resolver

The generic `run<T>()`/`runSettled<T>()` methods accept anything shaped like a `MultistepTask` — built-in task builders, `defineTask` output, or hand-written tasks:

```typescript
import { buildErc20Task, MulticallResolver } from "@halaprix/domino"

declare const resolver: MulticallResolver

// Use built-in task builders
const [token] = await resolver.run([
  buildErc20Task({ token: "0x1111111111111111111111111111111111111111" as const }),
])

// Per-task settlement instead of one bad task aborting the whole call.
// A FRESH array/instance, not the one above — buildErc20Task output is
// single-use, so reusing the same instance across two run()/runSettled()
// calls would throw DominoTaskReuseError (see below).
const settled = await resolver.runSettled([
  buildErc20Task({ token: "0x1111111111111111111111111111111111111111" as const }),
])
```

Remember: `buildErc20Task`/`buildErc4626Task`/`defineTask` output is single-use (see [Single-use contract](#single-use-contract) above) — build a fresh array of tasks for each `run`/`runSettled` call, exactly as the snippet above does.

## Framework-Agnostic Handlers

For testing or custom backends, use the handler functions directly with any `StepExecutor`:

```typescript
import { resolveErc4626Vault } from "@halaprix/domino"
import type { StepExecutor, RawResult, StepCall } from "@halaprix/domino"

const executor: StepExecutor = {
  async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
    // Execute `calls` however you like; return one RawResult per call, in order.
    return calls.map(() => ({ status: "success" as const, value: undefined }))
  },
}

const vault = await resolveErc4626Vault({
  executor,
  vault: "0x3333333333333333333333333333333333333333" as const,
  owner: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as const,
})
```

## Return Types

```typescript
import type { Address } from "@halaprix/domino"

// ERC20
interface Erc20TokenResolution {
  symbol: string | undefined
  decimals: number | undefined
  balance: bigint | undefined // undefined if no owner provided
}

// ERC4626
interface Erc4626VaultResolution {
  metadata: {
    symbol: string | undefined
    decimals: number | undefined
    underlyingAsset: Address | undefined
    /** @deprecated Use `position.maxWithdraw` instead (F11 — same value) */
    maxWithdraw: bigint | undefined  // unlimited = 2^256-1
    /** @deprecated Use `position.maxRedeem` instead (F11 — same value) */
    maxRedeem: bigint | undefined    // unlimited = 2^256-1
  }
  position: {
    balance: bigint
    assets: bigint | undefined
    maxWithdraw?: bigint // present only when the maxWithdraw call succeeds (F11)
    maxRedeem?: bigint   // present only when the maxRedeem call succeeds (F11)
  } | undefined
  //   balance = raw share balance (vault.balanceOf(owner))
  //   assets  = underlying amount (vault.convertToAssets(balance))
}
```

`metadata.maxWithdraw`/`metadata.maxRedeem` are kept for backward compatibility and always equal `position.maxWithdraw`/`position.maxRedeem` when both are present — new code should read them off `position` (which additionally omits the keys entirely, rather than resolving to `undefined`, when the underlying call fails — see [Deprecations](#deprecations)).

## Deprecations

These names/parameters still work, unchanged, through the rest of the 1.x line — no breaking changes are planned before 2.0:

| Deprecated | Replacement | Notes |
|---|---|---|
| `client:` param (`resolveErc20Token`, `resolveErc20Bulk`, `resolveErc4626Vault`, `resolveErc4626Bulk`) | `executor:` | Exclusive union — passing both `executor` and `client` throws `"Pass either 'executor' or 'client', not both — they are aliases ('client' is deprecated)"`. |
| `resolveErc20TokensBulk` | `resolveErc20Bulk` | Same function (`resolveErc20TokensBulk === resolveErc20Bulk`), forever-in-1.x alias. |
| `resolveErc4626VaultsBulk` | `resolveErc4626Bulk` | Same function (`resolveErc4626VaultsBulk === resolveErc4626Bulk`), forever-in-1.x alias. |
| `Erc4626VaultResolution.metadata.maxWithdraw`/`.maxRedeem` | `Erc4626VaultResolution.position.maxWithdraw`/`.maxRedeem` | Same values when both present; `position`'s copies are optional keys (omitted on call failure) rather than always-present `\| undefined` fields. |
| `makeResolver(executor)` | `new MulticallResolver(executor)` | Equivalent; `makeResolver` is kept as a function-call convenience wrapper. |

## API Surface

Import the following directly from `@halaprix/domino` (this list is exhaustive — it enumerates every export in `src/index.ts`):

**Core — FSM executor:**
- `runMultistepTasks<T>(executor: StepExecutor, tasks: MultistepTask<T>[], options?: BatchOptions): Promise<T[]>`
- `BatchOptions` — `{ batchSize?: number; maxConcurrentBatches?: number; maxBatchAttempts?: number; adaptiveBatching?: boolean; dedupe?: boolean; block?: BlockParam; pinBlock?: boolean; onPin?: (block: PinnedBlock) => void }`
- `PinnedBlock` — the resolved block reported to `onPin`: an explicit `blockNumber`, or `blockHash` + optional `requireCanonical` — see [Atomicity](#atomicity)

**Per-task settlement (`runSettled`):**
- `runSettled<T>(executor: StepExecutor, tasks: MultistepTask<T>[], options?: BatchOptions): Promise<SettledTaskResult<T>[]>`
- `TaskDiagnostics` — `{ optionalFailures: Array<{ target?: Address; functionName?: string; error: DominoCallError }> }`
- `SettledTaskResult<T>` — `{ status: 'fulfilled'; value: T; diagnostics: TaskDiagnostics } | { status: 'rejected'; error: unknown; diagnostics: TaskDiagnostics }`

**Ref-graph task builder (`defineTask`) + typed call specs:**
- `defineTask<const S>(build: (t: TaskBuilder) => S): MultistepTask<ResolveRefs<S>>`
- `TaskBuilder` — `{ call(spec): Ref<...>; derive(inputs, fn): Ref<...> }` (see [`defineTask`](#definetask--the-recommended-way-to-describe-a-task) above)
- `TypedCallSpec<abi, fn>` — the object shape accepted by `t.call` (`target`, `abi`, `functionName`, `args`, `optional?`, `dedupe?`)
- `Ref<T>` — opaque handle to a value produced by `t.call`/`t.derive`
- `WithRefs<T>` — widens each position of tuple `T` to `element | Ref<element | undefined>`
- `ResolveRefs<S>` — recursively resolves every `Ref<T>` leaf in `S` to `T`

**Error taxonomy:**
- `DominoCallError` — `class DominoCallError extends Error { kind, data?, target?, functionName?, key? }`
- `DominoCallErrorKind` — `'revert' | 'decode' | 'batch' | 'skipped' | 'derive'`
- `DominoCallErrorOptions` — constructor options for `DominoCallError`
- `DominoTaskReuseError` — `class DominoTaskReuseError extends Error {}`, thrown on single-use task reuse

**Eip1193Executor class:**
- `constructor(provider: Eip1193Provider)`
- `executeMulticall(calls: StepCall[], block?: BlockParam): Promise<RawResult[]>`
- `getBlockNumber(block?: BlockParam): Promise<bigint>` — resolves a `BlockParam` to a concrete block number. Exact contract: `block` absent or carrying a `blockTag` resolves via one `eth_getBlockByNumber` round-trip; an explicit `blockNumber` is returned as-is with no RPC at all; a `blockHash` block is rejected (throws `"getBlockNumber does not resolve block hashes"` — domino's own `pinBlock` pipeline never calls it that way, since an explicit hash needs no resolution to begin with). Used by `pinBlock` (see [Atomicity](#atomicity))
- `refreshChainId(): Promise<number>`

**`MulticallResolver<TAddr extends string = Address>` class** (implements `ResolverEngine<TAddr>`; signatures below use the default `TAddr = Address`):
- `constructor(executor: StepExecutor)`
- `get executor(): StepExecutor`
- `run<T>(tasks: MultistepTask<T>[], options?: BatchOptions): Promise<T[]>`
- `runSettled<T>(tasks: MultistepTask<T>[], options?: BatchOptions): Promise<SettledTaskResult<T>[]>`
- `resolveErc20(params: { token: Address; owner?: Address; block?: BlockParam }): Promise<Erc20TokenResolution>`
- `resolveErc20Bulk(params: { entries: { token: Address; owner?: Address }[]; batchSize?: number; block?: BlockParam }): Promise<Erc20TokenResolution[]>`
- `resolveErc4626(params: { vault: Address; owner?: Address; block?: BlockParam }): Promise<Erc4626VaultResolution>`
- `resolveErc4626Bulk(params: { entries: { vault: Address; owner?: Address }[]; batchSize?: number; block?: BlockParam }): Promise<Erc4626VaultResolution[]>`
- `makeResolver<TAddr extends string = Address>(executor: StepExecutor): ResolverEngine<TAddr>` — `@deprecated`, equivalent to `new MulticallResolver(executor)`
- `ResolverEngine<TAddr extends string = Address>` — the interface `MulticallResolver` implements. `TAddr` is the address representation the engine's params accept — `Address` (`0x${string}`) by default, or plain `string` for an engine (e.g. ethers v5) that doesn't use the `0x${string}` template-literal type.

**Constants and deployment helpers:**
- `MULTICALL3_ADDRESS: Address`
- `MULTICALL3_BYTECODE: string`
- `DEPLOYLESS_WRAPPER_BYTECODE: string`
- `MULTICALL3_DEPLOYMENTS: Record<number, { blockCreated: bigint }>`
- `shouldUseDeployless(chainId: number, block?: BlockParam): boolean`

**ERC20 handler:**
- `buildErc20Task(params: { token: Address; owner?: Address }): MultistepTask<Erc20TokenResolution>`
- `resolveErc20Token(params: { executor: StepExecutor; token: Address; owner?: Address; block?: BlockParam }): Promise<Erc20TokenResolution>` (also accepts `client:` instead of `executor:`, deprecated — passing both throws)
- `resolveErc20Bulk(params: { executor: StepExecutor; entries: { token: Address; owner?: Address }[]; batchSize?: number; block?: BlockParam }): Promise<Erc20TokenResolution[]>` — canonical name (F11)
- `resolveErc20TokensBulk` — `@deprecated` alias, same function object as `resolveErc20Bulk`
- `Erc20TokenResolution` — return type for ERC20 queries

**ERC4626 handler:**
- `buildErc4626Task(params: { vault: Address; owner?: Address }): MultistepTask<Erc4626VaultResolution>`
- `resolveErc4626Vault(params: { executor: StepExecutor; vault: Address; owner?: Address; block?: BlockParam }): Promise<Erc4626VaultResolution>` (also accepts `client:` instead of `executor:`, deprecated — passing both throws)
- `resolveErc4626Bulk(params: { executor: StepExecutor; entries: { vault: Address; owner?: Address }[]; batchSize?: number; block?: BlockParam }): Promise<Erc4626VaultResolution[]>` — canonical name (F11)
- `resolveErc4626VaultsBulk` — `@deprecated` alias, same function object as `resolveErc4626Bulk`
- `Erc4626VaultResolution` — return type for ERC4626 queries

**Bytecode/engine types:**
- `StepCall` — a single call in a multicall batch
- `StepResult` — result of a call routed back to its task
- `MultistepTask<T>` — stateful task pipeline (`maxStep`, `buildStepCalls`, `consumeStepResults`, `finalize`)
- `StepExecutor` — executor interface (`executeMulticall`; an optional `getBlockNumber` powers `pinBlock` — see [Atomicity](#atomicity))
- `RawResult` — raw return value before routing
- `Address` — hex string type alias (`0x${string}`)
- `BlockParam` — block identifier (blockNumber, blockTag, or blockHash)
- `BlockTag` — `'latest' | 'earliest' | 'pending' | 'safe' | 'finalized'`
- `Eip1193Provider` — minimal EIP-1193 provider interface
