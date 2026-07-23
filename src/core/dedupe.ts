/**
 * F7 — within-step, cross-task call dedup key computation.
 *
 * Scope (controller decision 3, `src/core/engine.ts`): dedup groups calls
 * WITHIN one step, ACROSS tasks, PRE-bisection — i.e. before the wire list
 * (the deduped call list) ever reaches `runBatchPool` (`src/core/pool.ts`).
 * This module owns only the KEY computation; `engine.ts` owns the actual
 * grouping/expansion (see its doc comment for the wire-list/subscriber-
 * fan-out data structure).
 *
 * **Key** = `(target.toLowerCase(), calldata, canonicalOutputSignature)`.
 * Calldata already captures selector+inputs, so it alone would merge two
 * subscribers that declare DIFFERENT output ABIs for the identical calldata
 * — corrupting whichever one didn't "win" the merge (first-decoder-wins).
 * `canonicalOutputSignature` is the one extra piece of information that
 * prevents that: two calls only merge when they'd also decode identically.
 *
 * **Eligibility** is a separate, per-call concern (`isDedupeEligible`) —
 * `dedupeKeyFor` folds both together and returns `undefined` whenever `call`
 * must never be merged with anything, for either reason:
 *   - not dedup-eligible (a legacy hand-authored `StepCall` never carries
 *     the `DEDUPE_ELIGIBLE` stamp at all; a `TypedCallSpec` with `dedupe:
 *     false` is stamped `false` explicitly) — "eligible", not "safe": `view`/
 *     `pure` alone do not guarantee referential transparency, so this is an
 *     opt-in the CALLER makes, not something domino infers from ABI
 *     mutability.
 *   - `encodeFunctionData` throws while computing the calldata portion of
 *     the key (e.g. args that don't match the ABI's input types) — the spec
 *     requires dedup to never introduce a NEW failure mode, so a
 *     keying-time failure simply falls back to "never merge this call";
 *     the executor still runs it (as its own wire call) and produces
 *     whatever error it normally would for bad args, downstream, unchanged.
 */

import type { Abi, AbiFunction } from 'abitype'
import type { StepCall } from './types'
import { encodeFunctionData } from './abi'
import { DEDUPE_ELIGIBLE } from './internal'

/**
 * Structural supertype every real `AbiParameter` already satisfies —
 * `AbiParameter` (abitype) is a discriminated union where `components`
 * exists ONLY on the tuple/tuple-array member, so accessing it unconditionally
 * (as the spec's `canon`, below, does) does not type-check without first
 * narrowing on `type`. Typing `canon`'s parameter against this looser
 * structural shape instead of `AbiParameter` directly keeps the function
 * body — the actual canonicalization logic — character-identical to the
 * spec text; only the parameter's TYPE ANNOTATION differs.
 */
type CanonParam = {
  readonly name?: string | undefined
  readonly type: string
  readonly components?: readonly CanonParam[] | undefined
}

/**
 * Spec text, VERBATIM (order-preserving, names included — see the module
 * doc's "Key" section for why names matter: viem decodes a named tuple to an
 * object and an unnamed one to an array, so a component's `name` affects the
 * DECODED SHAPE, not just cosmetics). Only the object-key order of the
 * produced `{ name, type, components }` representation is normalized (that's
 * an inherent property of building a fresh object literal here) — the
 * OUTPUT-ARRAY order and TUPLE-COMPONENT order themselves are never sorted,
 * because both are semantic.
 */
const canon = (p: CanonParam): unknown => ({ name: p.name ?? '', type: p.type, components: p.components?.map(canon) })

/**
 * True iff `call` opted into dedup eligibility. Reads the internal
 * `DEDUPE_ELIGIBLE` symbol stamped by `defineTask.ts` — absent entirely on
 * any hand-authored legacy `StepCall` (never eligible, no mutability promise
 * was ever made for it), `true` by default on a compiled `TypedCallSpec`
 * call, `false` when that spec set `dedupe: false`.
 */
export function isDedupeEligible(call: StepCall): boolean {
  return (call as unknown as Record<symbol, unknown>)[DEDUPE_ELIGIBLE] === true
}

/**
 * ABI function items matching `functionName`, narrowed by input arity when
 * that narrows to exactly one candidate — a lightweight mirror of how viem's
 * own overload resolution disambiguates by argument count/shape. When arity
 * does NOT narrow to a single candidate (zero matches, e.g. a mismatched
 * call that will fail downstream anyway, or more than one same-arity
 * overload — genuinely ambiguous without inspecting argument VALUE types),
 * this deliberately returns every same-named candidate instead of guessing:
 * `canonicalOutputSignature` below then keys on ALL of their outputs
 * together, so two calls that could plausibly resolve to different
 * overloads never spuriously merge just because one candidate's outputs
 * happen to coincide.
 */
function candidateFunctions(abi: Abi, functionName: string, argsLength: number): AbiFunction[] {
  const sameName = abi.filter(
    (item): item is AbiFunction => item.type === 'function' && item.name === functionName,
  )
  const arityMatches = sameName.filter((item) => item.inputs.length === argsLength)
  return arityMatches.length === 1 ? arityMatches : sameName
}

/**
 * `JSON.stringify(matchedItem.outputs?.map(canon) ?? [])` per the spec, for
 * the unambiguous (single-candidate) case. For the ambiguous case (see
 * `candidateFunctions` above), serializes every candidate's own
 * `outputs.map(canon)` list, in ABI order — documented choice, not the
 * spec's literal formula (which assumes one matched item).
 */
function canonicalOutputSignature(candidates: AbiFunction[]): string {
  if (candidates.length === 1) {
    return JSON.stringify(candidates[0]!.outputs?.map(canon) ?? [])
  }
  return JSON.stringify(candidates.map((item) => item.outputs?.map(canon) ?? []))
}

/**
 * Dedup key for `call`, or `undefined` when it must never be merged with
 * anything (see the module doc's "Eligibility" section for both reasons).
 * Callers (`src/core/engine.ts`) treat `undefined` identically regardless of
 * WHICH reason produced it: the call simply gets its own wire-list entry.
 */
export function dedupeKeyFor(call: StepCall): string | undefined {
  if (!isDedupeEligible(call)) return undefined
  try {
    const calldata = encodeFunctionData({
      abi: call.abi,
      functionName: call.functionName,
      // StepCall.args is untyped by design; viem validates at runtime — same
      // pattern as Eip1193Executor's own encodeFunctionData calls.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: call.args as any,
    })
    const candidates = candidateFunctions(call.abi, call.functionName, call.args?.length ?? 0)
    if (candidates.length === 0) return undefined
    const signature = canonicalOutputSignature(candidates)
    return JSON.stringify([call.target.toLowerCase(), calldata, signature])
  } catch {
    return undefined
  }
}
