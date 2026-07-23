/**
 * `Ref<T>` plumbing for F2 (`defineTask`).
 *
 * `Ref<T>` is an opaque, phantom-branded type: consumers can hold a `Ref<T>`,
 * pass it as a `target`/arg to another `t.call`, or feed it to `t.derive`, but
 * they cannot construct one directly (no exported constructor) or unwrap its
 * value (no exported accessor) — the only way to get a real value out of a
 * `Ref<T>` is to return it from `defineTask`'s builder callback and let
 * `finalize()` resolve it.
 *
 * At runtime a `Ref<T>` is backed by a `RefHandle` — a small object carrying
 * the internal node id `defineTask.ts`'s graph uses for depth/resolution
 * bookkeeping. The phantom brand (`REF_BRAND`) exists purely at the type
 * level (never assigned, never read) so `Ref<T>` structurally carries `T`
 * without requiring an actual runtime value of type `T` to exist anywhere.
 */

declare const REF_BRAND: unique symbol

/** Opaque reference to a value produced by `defineTask`'s `t.call`/`t.derive`. */
export type Ref<T> = { readonly [REF_BRAND]: T }

/**
 * Internal marker distinguishing a `RefHandle` from an ordinary call argument
 * (addresses, bigints, numbers, tuples, ...). Not exported — nothing outside
 * `defineTask.ts` needs to recognize a ref at runtime.
 */
const REF_MARKER = Symbol('domino.ref')

/** Internal runtime shape backing every `Ref<T>` — same object identity as
 *  the value handed back to consumers, reinterpreted here via the shared
 *  marker symbol. `id` is the node's creation-order index in its owning
 *  task's graph (also used, as-is, for "first by creation order" ordering
 *  in `defineTask.ts`'s finalize traversal — no separate ordering table
 *  needed). `own` is the owning `defineTask()` call's private token object
 *  (identity-only, never read for any value) — since `id`s restart at 0 per
 *  task, a bare `id` can't distinguish "my node 0" from "some OTHER task's
 *  node 0"; `defineTask.ts` checks `own === myToken` at build time before
 *  ever trusting an incoming ref's `id` against its own graph. */
export interface RefHandle {
  readonly [REF_MARKER]: true
  readonly id: number
  readonly own: object
}

/** Mint a new `Ref<T>` wrapping internal node `id`, owned by `own`. `defineTask.ts`-only. */
export function makeRef<T>(id: number, own: object): Ref<T> {
  const handle: RefHandle = { [REF_MARKER]: true, id, own }
  return handle as unknown as Ref<T>
}

/**
 * Runtime type guard: is `value` a `RefHandle` (i.e. was it produced by
 * `makeRef`)? Optional-chained property access is safe on any `unknown`
 * value here — primitives auto-box for a read (never throw) and
 * null/undefined short-circuit via `?.` — so this needs no separate
 * `typeof`/null check first.
 */
export function isRefHandle(value: unknown): value is RefHandle {
  return (value as { [REF_MARKER]?: unknown } | null | undefined)?.[REF_MARKER] === true
}

/**
 * Makes `Ref<T>` assignable at every position of an args tuple: each element
 * of `T` becomes `element | Ref<element | undefined>`. Works for both
 * fixed-length tuples (arity/position preserved — homomorphic mapped type
 * over a tuple-constrained generic) and variable-length arrays.
 *
 * Accepting `Ref<element | undefined>` (not just `Ref<element>`) at every
 * position is deliberate: it is what lets an `optional: true` call's ref
 * (typed `Ref<T | undefined>`) feed another call's arg/target position at
 * all — the type system allows it, and the runtime skip-chain rule handles
 * the case where it actually resolves to `undefined` (that call gets
 * skipped; see `defineTask.ts`). A plain `Ref<element>` is always assignable
 * here too, since `Ref` is structurally covariant in `T`.
 */
export type WithRefs<T extends readonly unknown[]> = {
  [K in keyof T]: T[K] | Ref<T[K] | undefined>
}

/**
 * Maps the shape returned by `defineTask`'s builder callback: every `Ref<T>`
 * leaf resolves to `T`, recursively through plain objects, arrays, and
 * tuples. Non-ref values (including literal types) pass through unchanged.
 *
 * **Limitation:** this type does not (and at runtime, `defineTask`'s
 * `finalize()` does not either) resolve a `Ref` nested inside a class
 * instance or other non-plain object (`new Box(ref)`, a `Map`, etc.) — those
 * pass through structurally untouched by the runtime's shallow safety check,
 * which only catches a `Ref` sitting at that object's own top-level
 * enumerable properties (throwing there rather than silently returning an
 * unresolved ref). A `Ref` nested two or more levels deep inside such an
 * object (e.g. `new Box({ inner: ref })`) is NOT detected and is the
 * consumer's own responsibility to avoid — return refs through plain
 * objects/arrays/tuples instead.
 */
export type ResolveRefs<S> = S extends Ref<infer T>
  ? T
  : S extends (...args: never[]) => unknown
    ? S
    : S extends readonly unknown[]
      ? { [K in keyof S]: ResolveRefs<S[K]> }
      : S extends object
        ? { [K in keyof S]: ResolveRefs<S[K]> }
        : S
