/**
 * `MultichainResolver` (F9) — runs the same task-shaped work across several
 * chains in parallel, each chain going through the existing single-chain
 * runners (`runMultistepTasks`/`runSettled`) untouched. This module adds NO
 * new execution machinery — it is purely a fan-out/fan-in layer over one
 * `StepExecutor` (or lazily-wrapped `Eip1193Provider`) per chain.
 *
 * **[v5] Flattened duplicate-instance validation** is this module's one
 * genuinely new safety rule (see `assertNoFlattenedDuplicates` below): a
 * branded (single-use) task instance appearing more than once ANYWHERE in a
 * `runAll`/`runAllSettled` plan — twice in one chain's array, or once each
 * under two different chain ids — is rejected UP FRONT, before any chain's
 * runner is invoked. Without this, two chains would race to consume the
 * same branded instance (each runner's own `markTasksConsumed` only
 * guards against a SECOND caller of `runMultistepTasks`/`runSettled`, not
 * against two callers racing concurrently against the same instance) —
 * whichever chain loses that race would throw `DominoTaskReuseError`
 * mid-run, potentially leaving that chain's sibling tasks executed against
 * a step loop that never reaches `finalize()`. Scanning the whole flattened
 * plan first and consuming nothing on failure means every task, from every
 * chain, is still fully resubmittable after the throw.
 */

import type { Eip1193Provider, StepExecutor, MultistepTask, BlockParam } from '../core/types'
import { runMultistepTasks, type BatchOptions } from '../core/runMultistepTasks'
import { runSettled, type SettledTaskResult } from '../core/runSettled'
import { SINGLE_USE, type SingleUseCarrier } from '../core/internal'
import { DominoTaskReuseError } from '../core/errors'
import { Eip1193Executor } from './eip1193'
import { MulticallResolver } from './resolver'

/** `runAll`/`runAllSettled` options — `BatchOptions` plus a per-chain block override. */
export interface MultichainRunOptions extends BatchOptions {
  /**
   * Per-chain block override — takes precedence over the top-level `block`
   * for that one chain only. Chains with no entry here (or no `blocks` map
   * at all) fall back to `options.block` exactly as a single-chain call
   * would.
   *
   * Never forwarded to `runMultistepTasks`/`runSettled` itself — only the
   * per-chain resolved `block` is (see `effectiveOptionsFor` below); a
   * single-chain `StepExecutor`/`BatchOptions` consumer has no use for a
   * map keyed by every OTHER chain's id.
   */
  blocks?: Record<number, BlockParam>
}

function isStepExecutor(entry: Eip1193Provider | StepExecutor): entry is StepExecutor {
  return typeof (entry as StepExecutor).executeMulticall === 'function'
}

function isEip1193Provider(entry: Eip1193Provider | StepExecutor): entry is Eip1193Provider {
  return typeof (entry as Eip1193Provider).request === 'function'
}

/**
 * [v5] Scans EVERY task array in `plan` — across ALL chains, not just one —
 * for a branded (single-use) instance appearing more than once. Mirrors
 * `rejectDuplicateInstances`'s approach in `src/core/internal.ts` exactly
 * (single O(n) pass, a `Set` allocated lazily on the first branded task seen,
 * legacy unbranded instances never checked/never throw — 1.0's "duplicate
 * stateless task in one array" pattern stays supported) — just widened to
 * treat the flattened, cross-chain plan as one array instead of one chain's.
 *
 * Consumes nothing: this only reads `[SINGLE_USE]`, it never marks anything
 * consumed — every task in `plan`, including the two colliding instances
 * themselves, remains fully resubmittable after this throws.
 */
function assertNoFlattenedDuplicates<T>(plan: Record<number, MultistepTask<T>[]>): void {
  let seen: Set<MultistepTask<T>> | undefined
  for (const key of Object.keys(plan)) {
    const chainId = Number(key)
    const tasks = plan[chainId] ?? []
    for (const t of tasks) {
      if (!(t as MultistepTask<T> & SingleUseCarrier)[SINGLE_USE]) continue
      seen ??= new Set()
      if (seen.has(t)) {
        throw new DominoTaskReuseError(
          'Same task instance appears more than once in this multichain plan (either twice in one ' +
            "chain's array, or once each under two different chain ids) — domino tasks are " +
            'single-run, and reusing one across chains racing in parallel could leave one chain ' +
            'mid-run when the other consumes it first; create a fresh task instance per chain entry',
        )
      }
      seen.add(t)
    }
  }
}

/**
 * Effective per-chain `BatchOptions`: `options.blocks?.[chainId]` wins over
 * `options.block` for that one chain; every other field passes through
 * unchanged. `blocks` itself is always stripped before this reaches
 * `runMultistepTasks`/`runSettled` — those only know `BatchOptions`, which
 * has no `blocks` field at all.
 *
 * Destructuring (not a spread-then-delete) keeps this `exactOptionalPropertyTypes`-safe:
 * `rest` only ever carries a `block` key when the caller's own `options` did,
 * and the override branch sets `block` to a value that is never `undefined`
 * (guarded by the `!== undefined` check) — an explicit `block: undefined` is
 * never assigned here.
 */
function effectiveOptionsFor(chainId: number, options: MultichainRunOptions | undefined): BatchOptions {
  if (!options) return {}
  const { blocks, ...rest } = options
  const chainBlock = blocks?.[chainId]
  return chainBlock !== undefined ? { ...rest, block: chainBlock } : rest
}

/**
 * Runs task plans across several chains in parallel — one `StepExecutor`
 * (deployed/deployless Multicall3, or a custom `StepExecutor`) per chain id,
 * fanning `runAll`/`runAllSettled` out to the existing single-chain runners.
 *
 * **Single-`T` generic:** `runAll<T>`/`runAllSettled<T>` type every chain's
 * tasks as `MultistepTask<T>[]` — mixed shapes across chains require
 * separate `chain(id).run(...)` calls (one per distinct result shape)
 * instead of a single `runAll` invocation.
 *
 * **`onPin` and multichain:** each chain's runner resolves and reports its
 * OWN pin independently (F8's "once per run" becomes "once per chain" here)
 * — `onPin` itself receives no chain id, so a single shared callback cannot
 * tell which chain's pin it just saw. Consumers needing that attribution
 * should use `snapshot()` (which DOES return a chain-keyed block map) plus
 * explicit per-chain `blocks` overrides instead of relying on `onPin`'s
 * callback identity to disambiguate.
 */
export class MultichainResolver {
  readonly #entries: Map<number, Eip1193Provider | StepExecutor>
  readonly #executors = new Map<number, StepExecutor>()
  readonly #resolvers = new Map<number, MulticallResolver>()

  constructor(chains: Record<number, Eip1193Provider | StepExecutor>) {
    const keys = Object.keys(chains)
    if (keys.length === 0) {
      throw new Error('MultichainResolver: at least one chain is required (received an empty chains record)')
    }

    this.#entries = new Map()
    for (const key of keys) {
      const chainId = Number(key)
      const entry = chains[chainId]!
      // Discrimination order matters: a `StepExecutor` (callable
      // `executeMulticall`) is checked first and used as-is; only then is a
      // callable `request` treated as an `Eip1193Provider` awaiting lazy
      // wrapping. Anything satisfying neither shape is a construction error.
      if (isStepExecutor(entry)) {
        this.#entries.set(chainId, entry)
      } else if (isEip1193Provider(entry)) {
        this.#entries.set(chainId, entry)
      } else {
        throw new Error(
          `MultichainResolver: chain ${key} is neither a StepExecutor (callable executeMulticall) ` +
            'nor an Eip1193Provider (callable request)',
        )
      }
    }
  }

  get #chainIds(): number[] {
    return [...this.#entries.keys()]
  }

  /**
   * Resolves (lazily wrapping + caching an `Eip1193Provider` entry into an
   * `Eip1193Executor` on first use) the `StepExecutor` for `chainId`. Every
   * caller inside this class — `chain()`, `snapshot()`, `runAll`,
   * `runAllSettled` — funnels through this ONE cache, so a provider is
   * wrapped exactly once no matter which of those is called first, or how
   * many times.
   */
  #executorFor(chainId: number): StepExecutor {
    const cached = this.#executors.get(chainId)
    if (cached) return cached

    const entry = this.#entries.get(chainId)
    if (!entry) {
      const known = this.#chainIds.sort((a, b) => a - b).join(', ')
      throw new Error(`MultichainResolver: unknown chainId ${chainId} (known chain ids: ${known})`)
    }

    const executor = isStepExecutor(entry) ? entry : new Eip1193Executor(entry)
    this.#executors.set(chainId, executor)
    return executor
  }

  /**
   * Throws before ANY chain begins execution if `plan` references a chain id
   * this resolver wasn't constructed with.
   */
  #assertKnownPlanChainIds(planChainIds: number[]): void {
    const known = new Set(this.#chainIds)
    for (const chainId of planChainIds) {
      if (!known.has(chainId)) {
        const knownList = [...known].sort((a, b) => a - b).join(', ')
        throw new Error(`MultichainResolver: plan references unknown chainId ${chainId} (known chain ids: ${knownList})`)
      }
    }
  }

  /**
   * A cached `MulticallResolver` wrapping `chainId`'s (lazily created)
   * executor. Same instance every call — `toBe`-stable — so callers may
   * safely hold onto `chain(id)` across a run instead of re-deriving it.
   * Unknown `chainId` throws immediately, listing every known id.
   */
  chain(chainId: number): MulticallResolver {
    const cached = this.#resolvers.get(chainId)
    if (cached) return cached

    const executor = this.#executorFor(chainId) // throws for an unknown chainId
    const resolver = new MulticallResolver(executor)
    this.#resolvers.set(chainId, resolver)
    return resolver
  }

  /**
   * Resolves the current block number of EVERY constructed chain in
   * parallel — `Promise.all` over `executor.getBlockNumber()`.
   *
   * Capability is checked for ALL chains BEFORE any RPC is dispatched: a
   * single chain lacking `getBlockNumber` throws synchronously, with zero
   * `request` calls made against ANY chain (not just the offending one).
   *
   * If one chain's `getBlockNumber()` rejects, `snapshot()` rejects with
   * that error — but every OTHER in-flight promise already has an explicit
   * no-op `.catch` attached (in the same synchronous pass that started them,
   * before the `Promise.all` below), so a sibling settling AFTER the
   * rejection has already propagated can never surface as a Node
   * `unhandledRejection`.
   */
  async snapshot(): Promise<Record<number, bigint>> {
    const chainIds = this.#chainIds
    const executors = chainIds.map((chainId) => this.#executorFor(chainId))

    for (let i = 0; i < chainIds.length; i++) {
      if (typeof executors[i]!.getBlockNumber !== 'function') {
        throw new Error(
          `MultichainResolver.snapshot: chain ${chainIds[i]} executor does not implement getBlockNumber ` +
            '(Eip1193Executor implements it; a custom StepExecutor must add it to opt in)',
        )
      }
    }

    const pending = executors.map((executor) => executor.getBlockNumber!())
    for (const p of pending) p.catch(() => {})

    const values = await Promise.all(pending)

    const out: Record<number, bigint> = {}
    for (let i = 0; i < chainIds.length; i++) out[chainIds[i]!] = values[i]!
    return out
  }

  /**
   * Runs `plan[chainId]` against chain `chainId`'s executor for every chain
   * key in `plan`, all concurrently, via the existing `runMultistepTasks`.
   *
   * Validation (unknown plan chain id, [v5] flattened duplicate instances)
   * happens entirely BEFORE any chain's runner is invoked — see
   * `#assertKnownPlanChainIds`/`assertNoFlattenedDuplicates` above.
   *
   * **Failure policy:** if any chain rejects, `runAll` rejects — with the
   * rejection of the LOWEST chainId among the chains that rejected
   * (deterministic; analogous to the concurrency pool's lowest-index
   * selection in `src/core/pool.ts`). Every chain's promise gets both its
   * fulfillment and rejection handlers attached synchronously via `.then`
   * BEFORE `Promise.all` is awaited, so no chain's settlement — whichever
   * order they land in — can ever surface as an unhandled rejection.
   * In-flight chains are never cancelled because a sibling rejected: each
   * chain's own single-chain fail-fast behavior (if any) still applies
   * within it, but there is no CROSS-chain cancellation.
   */
  async runAll<T>(plan: Record<number, MultistepTask<T>[]>, options?: MultichainRunOptions): Promise<Record<number, T[]>> {
    const chainIds = Object.keys(plan).map(Number)
    this.#assertKnownPlanChainIds(chainIds)
    assertNoFlattenedDuplicates(plan)

    if (chainIds.length === 0) return {}

    type Settlement = { chainId: number } & (
      | { status: 'fulfilled'; value: T[] }
      | { status: 'rejected'; error: unknown }
    )

    const settlements: Promise<Settlement>[] = chainIds.map((chainId) => {
      const executor = this.#executorFor(chainId)
      const tasks = plan[chainId] ?? []
      const effectiveOptions = effectiveOptionsFor(chainId, options)
      return runMultistepTasks(executor, tasks, effectiveOptions).then(
        (value): Settlement => ({ chainId, status: 'fulfilled', value }),
        (error: unknown): Settlement => ({ chainId, status: 'rejected', error }),
      )
    })

    const settled = await Promise.all(settlements)

    const rejected = settled.filter(
      (s): s is Extract<Settlement, { status: 'rejected' }> => s.status === 'rejected',
    )
    if (rejected.length > 0) {
      rejected.sort((a, b) => a.chainId - b.chainId)
      throw rejected[0]!.error
    }

    const results: Record<number, T[]> = {}
    for (const s of settled) {
      if (s.status === 'fulfilled') results[s.chainId] = s.value
    }
    return results
  }

  /**
   * Per-chain settlement variant of {@link runAll}: never rejects on a
   * task/call failure (each chain's own `runSettled` isolates those into its
   * `SettledTaskResult[]`) — only a programmer error (e.g. an invalid
   * `batchSize`, or a `pinBlock` capability rejection for a chain's
   * executor) rejects the whole call, exactly as it would for a single-chain
   * `runSettled`. The [v5] flattened-duplicate and unknown-plan-chain-id
   * checks still run up front, before any chain starts, same as `runAll`.
   */
  async runAllSettled<T>(
    plan: Record<number, MultistepTask<T>[]>,
    options?: MultichainRunOptions,
  ): Promise<Record<number, SettledTaskResult<T>[]>> {
    const chainIds = Object.keys(plan).map(Number)
    this.#assertKnownPlanChainIds(chainIds)
    assertNoFlattenedDuplicates(plan)

    if (chainIds.length === 0) return {}

    const settlements = chainIds.map(async (chainId) => {
      const executor = this.#executorFor(chainId)
      const tasks = plan[chainId] ?? []
      const effectiveOptions = effectiveOptionsFor(chainId, options)
      const value = await runSettled(executor, tasks, effectiveOptions)
      return { chainId, value }
    })

    const settled = await Promise.all(settlements)

    const results: Record<number, SettledTaskResult<T>[]> = {}
    for (const { chainId, value } of settled) results[chainId] = value
    return results
  }
}
