/**
 * `defineTask` — ref-graph builder (F2) + typed call specs (F1).
 *
 * `defineTask(build)` runs `build` exactly once, synchronously. Every call
 * `t.call(spec)` / `t.derive(inputs, fn)` makes inside `build` mints a new
 * internal node and returns an opaque `Ref<T>` pointing at it — refs can
 * only be created this way, so the graph is a DAG by construction (a node
 * can only reference nodes minted before it).
 *
 * The result compiles to a plain `MultistepTask<ResolveRefs<S>>`: a step is
 * just "depth" in this DAG (`buildStepCalls(step)` emits the calls whose
 * depth === step), so it drops straight into `runMultistepTasks`/`run`/
 * `runSettled`, batched with other tasks (including legacy hand-written
 * ones) exactly like any other `MultistepTask`.
 *
 * See the module-level design walkthrough in the task report for the full
 * depth/resolution/finalize algorithm.
 */

import type { Abi } from 'abitype'
import type { ContractFunctionArgs, ContractFunctionName, ContractFunctionReturnType } from 'viem'
import type { Address, MultistepTask, StepCall, StepResult } from './types'
import type { Ref, WithRefs, ResolveRefs, RefHandle } from './refs'
import { makeRef, isRefHandle } from './refs'
import { DominoCallError as E } from './errors' // alias only shortens THIS file's source; esbuild resolves imports to the shared top-level binding when bundling, so it costs nothing either way
import { DIAGNOSTICS as DG } from './runSettled'
import type { TaskDiagnostics, DiagnosticsCarrier } from './runSettled'

// ─── Public types ───────────────────────────────────────────────────────────

/** View/pure function names of `abi` — the only functions `t.call` accepts
 *  (F1: the invariant that makes dedup, 1.2, result-preserving).
 *
 * Uses viem's `ContractFunctionName` (not abitype's `ExtractAbiFunctionNames`
 * directly) so `fn` is trivially assignable to the constraint viem's own
 * `ContractFunctionArgs`/`ContractFunctionReturnType` expect for their own
 * `functionName` type parameter — the two are equal by construction in the
 * concrete case, but only `ContractFunctionName` is *definitionally* that
 * constraint, which matters when `abi`/`fn` are still generic (unresolved)
 * type parameters at the point of the check. */
type ViewPureFunctionName<abi extends Abi> = ContractFunctionName<abi, 'view' | 'pure'>

/** `ContractFunctionArgs<...>` is `readonly unknown[]` once `abi extends Abi`
 *  is concrete, but TS cannot prove that generically (it can widen to
 *  `unknown`) — this wrapper gives `WithRefs` a constraint-safe input in the
 *  still-generic case without changing the concrete-case result. */
type ArgsOf<abi extends Abi, fn extends ViewPureFunctionName<abi>> =
  ContractFunctionArgs<abi, 'view' | 'pure', fn> extends infer A extends readonly unknown[]
    ? A
    : readonly unknown[]

/**
 * Typed spec for a single `t.call`. `target`/`args` positions accept either
 * a plain value or a `Ref` to a value produced earlier in the same task
 * (`WithRefs`) — this is what makes dynamic targets and dependent args work.
 *
 * `abi` is a plain `Abi` today; the field is deliberately typed so a future
 * `readonly string[]` (F3, human-readable ABI) widening is additive, not
 * implemented here.
 */
export interface TypedCallSpec<abi extends Abi, fn extends ViewPureFunctionName<abi>> {
  target: Address | Ref<Address>
  abi: abi
  functionName: fn
  args?: WithRefs<ArgsOf<abi, fn>>
  /** `true` → the returned ref is `Ref<Return | undefined>`; see the module doc. */
  optional?: boolean
  /** Accepted and stored now; read by dedup (1.2). Default: eligible (`true`). */
  dedupe?: boolean
}

/** The builder passed into `defineTask`'s callback. */
export interface TaskBuilder {
  call<const abi extends Abi, fn extends ViewPureFunctionName<abi>>(
    spec: TypedCallSpec<abi, fn> & { readonly optional: true },
  ): Ref<ContractFunctionReturnType<abi, 'view' | 'pure', fn> | undefined>
  call<const abi extends Abi, fn extends ViewPureFunctionName<abi>>(
    spec: TypedCallSpec<abi, fn>,
  ): Ref<ContractFunctionReturnType<abi, 'view' | 'pure', fn>>

  derive<const I extends readonly Ref<unknown>[], R>(
    inputs: I,
    fn: (...values: ResolveRefs<I>) => R,
  ): Ref<R>
}

// ─── Internal graph representation ─────────────────────────────────────────

/** Internal, non-exported marker stamped on every compiled StepCall. `true`
 *  unless the spec had `dedupe: false`. Nothing reads it yet — dedup (1.2)
 *  does. Deliberately NOT exported (not even for tests): presence/value are
 *  verified via `Object.getOwnPropertySymbols` + `Symbol.description`. */
const DEDUPE_ELIGIBLE = Symbol('domino.dedupeEligible')

/**
 * Internal graph node — call and derive nodes share ONE flat (mostly
 * optional-field) shape rather than a discriminated union: `fn` present ⟺
 * derive node, absent ⟺ call node. `st` is the memoized resolution result,
 * written in place once known (absent ⟺ still pending). Node ids are the
 * `nodes` Map's keys (not stored redundantly on the node itself) — every
 * function that needs a node's id already has it in hand (either iterating
 * `nodes` directly, or via a `RefHandle.id`), and that same numeric id IS
 * creation order, so no separate ordering table is needed either.
 *
 * Field names are deliberately terse — this interface (and every helper
 * below it) is 100% private, closure-scoped implementation, never observed
 * by a consumer or even another module, so the usual "spell it out" bias
 * loses to the F2 acceptance budget (raw bundle size). Legend: `dep` depth,
 * `ab` call abi, `nm` call functionName, `ar` call target+args (position 0
 * is ALWAYS the target, `ar.slice(1)` the actual args — folded together so
 * depth computation and resolution share one list/loop instead of two),
 * `op` call optional, `dd` call dedupeEligible, `ins` derive inputs.
 */
interface Node {
  readonly dep: number
  readonly fn?: (...values: unknown[]) => unknown
  readonly ins?: readonly { readonly id: number }[]
  readonly ab?: Abi
  readonly nm?: string
  readonly ar?: readonly unknown[] // [0] target, rest args; each: value | RefHandle
  readonly op?: boolean
  readonly dd?: boolean
  st?: St
}

/**
 * Resolution state of one node/arg. `v` = ready value. `u` = the node was
 * `optional: true` and failed — value is `undefined` for a DERIVE consumer,
 * but a CALL consuming it cannot encode `undefined` and must skip (treated
 * the same as `f`, see `resolveAll`). `f` = hard failure (own call failed
 * non-optionally, a derive threw, or skip-chained from an `f`/`u` upstream).
 * The original error is always preserved on `u`/`f` (never discarded).
 */
type St =
  | { readonly k: 'v'; readonly value: unknown }
  | { readonly k: 'u'; readonly error: E }
  | { readonly k: 'f'; readonly error: E }

function isPO(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false
  const p = Object.getPrototypeOf(v) as object | null
  return p === Object.prototype || p === null
}

// ─── defineTask ─────────────────────────────────────────────────────────────

export function defineTask<const S>(build: (t: TaskBuilder) => S): MultistepTask<ResolveRefs<S>> {
  const N = new Map<number, Node>()
  const diag: TaskDiagnostics = { optionalFailures: [] }

  let nextId = 0
  let maxDep = 0

  const depOf = (v: unknown): number => (isRefHandle(v) ? (N.get(v.id)?.dep ?? 0) : 0)
  const maxDepOf = (xs: readonly unknown[]): number =>
    xs.reduce((m: number, x) => Math.max(m, depOf(x)), 0)
  /** `{ target }` when node `n`'s resolved position 0 is a literal address,
   *  else `{}` — shared by both DominoCallError-construction sites below
   *  (a dynamic `Ref<Address>` target that never resolved has no value to
   *  report here; that's fine, `target` is always optional on the error). */
  const tgt = (n: Node): { target?: Address } =>
    typeof n.ar?.[0] === 'string' ? { target: n.ar[0] as Address } : {}

  function callImpl(spec: {
    target: unknown
    abi: Abi
    functionName: string
    args?: readonly unknown[]
    optional?: boolean
    dedupe?: boolean
  }): Ref<unknown> {
    const ar = [spec.target, ...(spec.args ?? [])]
    const dep = maxDepOf(ar) + 1
    const id = nextId++
    N.set(id, {
      dep,
      ab: spec.abi,
      nm: spec.functionName,
      ar,
      op: !!spec.optional,
      dd: spec.dedupe !== false,
    })
    if (dep > maxDep) maxDep = dep
    return makeRef(id)
  }

  function deriveImpl(
    inputs: readonly Ref<unknown>[],
    fn: (...values: unknown[]) => unknown,
  ): Ref<unknown> {
    // No transform needed: every Ref<unknown> IS already a RefHandle at
    // runtime (makeRef's own return value, just reinterpreted here) — a type
    // cast, not a `.map()`, since there's nothing to actually convert.
    const ins = inputs as unknown as readonly RefHandle[]
    const id = nextId++
    N.set(id, { dep: maxDepOf(ins), fn, ins })
    return makeRef(id)
  }

  const builder = { call: callImpl, derive: deriveImpl } as unknown as TaskBuilder
  const shape = build(builder)

  // ---- resolution engine (lazy: derives compute on first demand, memoized) ----

  function fail(n: Node, error: E): void {
    if (n.op) {
      // Address/functionName are non-empty strings whenever present, so a
      // truthiness check doubles as the exactOptionalPropertyTypes-safe
      // "omit the key entirely when absent" guard (same as `tgt` above).
      const { target, functionName } = error
      diag.optionalFailures.push({ ...(target && { target }), ...(functionName && { functionName }), error })
      n.st = { k: 'u', error }
    } else {
      n.st = { k: 'f', error }
    }
  }

  function skip(id: number, n: Node, cause: E): void {
    fail(
      n,
      new E(`${n.nm} skipped`, {
        kind: 'skipped',
        cause,
        functionName: n.nm!,
        key: String(id),
        ...tgt(n),
      }),
    )
  }

  /** Resolve node `id` to its `St`, memoized on `.st`. Derive nodes compute
   *  lazily here (their `fn` runs at most once — cached on first call). */
  function res(id: number): St {
    // Non-null: ids are only minted by callImpl/deriveImpl right before
    // `nodes.set`, and RefHandles only ever wrap such an id (makeRef).
    const n = N.get(id)!
    if (n.st) return n.st
    if (!n.fn) {
      // Call nodes resolve exclusively via consumeStepResults/skip during
      // buildStepCalls; reaching here means a depth-assignment bug, not a
      // call failure — genuinely unreachable given the invariant above, so
      // a plain crash (not a DominoCallError — this isn't a call failure)
      // is the right signal.
      throw new Error('unreachable')
    }

    const { vs, c } = resolveAll(n.ins!, true)

    let st: St
    if (c) {
      st = { k: 'f', error: new E('skipped', { kind: 'skipped', cause: c }) }
    } else {
      try {
        st = { k: 'v', value: n.fn(...vs) }
      } catch (thrown) {
        st = { k: 'f', error: new E('derive threw', { kind: 'derive', cause: thrown }) }
      }
    }
    return (n.st = st)
  }

  /**
   * Shared by both `res`'s derive-input loop and `buildStepCalls`' target+arg
   * loop: resolve every position in `xs` (a plain value resolves to itself,
   * a `RefHandle` resolves via `res`), short-circuiting on the first
   * unusable one. `deriveMode` controls the ONE behavioral difference
   * between the two callers (see `St`'s doc comment): an `'u'` position
   * resolves to `undefined` and the loop continues when `deriveMode` is
   * true (a derive CAN consume `undefined`); otherwise `'u'` is treated
   * exactly like `'f'` (a call cannot encode `undefined`).
   */
  function resolveAll(xs: readonly unknown[], deriveMode?: boolean): { vs: unknown[]; c?: E } {
    const vs: unknown[] = []
    for (const x of xs) {
      const r: St = isRefHandle(x) ? res(x.id) : { k: 'v', value: x }
      if (r.k === 'f' || (r.k === 'u' && !deriveMode)) return { vs, c: r.error }
      vs.push(r.k === 'u' ? undefined : r.value)
    }
    return { vs }
  }

  // ---- MultistepTask surface ----

  function buildStepCalls(step: number): StepCall[] {
    if (step < 1 || step > maxDep) return []

    const calls: (StepCall & { [DEDUPE_ELIGIBLE]: boolean })[] = []
    for (const [id, n] of N) {
      if (n.fn || n.dep !== step) continue

      // n.ar[0] is always the target (see Node's legend) — resolving it
      // first means a target failure short-circuits before any arg is even
      // touched.
      const { vs, c } = resolveAll(n.ar!)
      if (c) {
        skip(id, n, c)
        continue
      }

      const [tv, ...av] = vs
      calls.push({
        key: String(id),
        target: tv as Address,
        abi: n.ab!,
        functionName: n.nm!,
        ...(av.length > 0 ? { args: av } : {}),
        [DEDUPE_ELIGIBLE]: n.dd!,
      })
    }
    return calls
  }

  function consumeStepResults(_step: number, results: StepResult[]): void {
    for (const r of results) {
      const n = N.get(Number(r.key))
      if (!n || n.fn) continue

      if (r.status === 'success') {
        n.st = { k: 'v', value: r.value }
        continue
      }

      // r.error may be: a real DominoCallError (forward as-is), some OTHER
      // raw error from a custom StepExecutor (synthesize, but preserve it as
      // `cause` — never discard it), or genuinely absent (synthesize with no
      // cause at all). Conflating "wrong type" with "absent" would silently
      // destroy a custom executor's raw error — the one thing this taxonomy
      // promises never happens.
      const error =
        r.error instanceof E
          ? r.error
          : new E(`${n.nm} failed`, {
              kind: 'batch',
              functionName: n.nm!,
              key: r.key,
              ...tgt(n),
              ...(r.error !== undefined ? { cause: r.error } : {}),
            })
      fail(n, error)
    }
  }

  function resShape(v: unknown, fails: { o: number; error: E }[]): unknown {
    if (isRefHandle(v)) {
      const st = res(v.id)
      if (st.k === 'v') return st.value
      if (st.k === 'u') return undefined
      fails.push({ o: v.id, error: st.error })
      return undefined
    }
    if (Array.isArray(v)) return v.map((x) => resShape(x, fails))
    if (isPO(v)) {
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(v)) out[k] = resShape(v[k], fails)
      return out
    }
    return v
  }

  function finalize(): unknown {
    const fails: { o: number; error: E }[] = []
    const resolved = resShape(shape, fails)
    if (fails.length > 0) {
      fails.sort((a, b) => a.o - b.o)
      throw fails[0]!.error
    }
    return resolved
  }

  const compiled: MultistepTask<unknown> & DiagnosticsCarrier = {
    maxStep: maxDep,
    buildStepCalls,
    consumeStepResults,
    finalize,
    [DG]: () => diag,
  }

  return compiled as unknown as MultistepTask<ResolveRefs<S>>
}
