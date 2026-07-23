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
import { encodeFunctionData, toFunctionSelector } from './abi'
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
 * The ABI function item that `calldata` was ACTUALLY encoded against —
 * resolved by SELECTOR, not by name+arity (external review, P1: arity alone
 * cannot disambiguate two same-arity overloads, e.g. `f(uint256)` and
 * `f(address)` both take exactly one input; the old arity-based fallback
 * conflated such overloads' outputs together, which could produce IDENTICAL
 * serialized signatures for two ABIs that pair inputs to outputs
 * differently — exactly the corruption the key exists to prevent).
 *
 * A function selector is the first 4 bytes of `keccak256(signature)`, fixed
 * by the function's OWN name+input-types alone — never by which ABI array
 * it's declared in, nor by that ABI's OTHER overloads. Since `calldata` was
 * produced by `encodeFunctionData` from this exact `(abi, functionName,
 * args)` triple, its first 4 bytes are the selector of whichever single
 * item `encodeFunctionData` actually resolved `functionName`/`args` to —
 * finding the same-named candidate whose OWN computed selector matches
 * therefore recovers that EXACT item, unambiguously, with no arity
 * heuristic and no risk of conflating two overloads' outputs.
 *
 * Returns `undefined` if no same-named candidate's selector matches (should
 * not happen given `calldata` was just encoded from this same abi, but
 * handled defensively — see `dedupeKeyFor`'s catch-all "never merge"
 * fallback).
 */
function matchedFunctionFor(abi: Abi, functionName: string, calldata: `0x${string}`): AbiFunction | undefined {
  const selector = calldata.slice(0, 10).toLowerCase()
  for (const item of abi) {
    if (item.type !== 'function' || item.name !== functionName) continue
    if (toFunctionSelector(item).toLowerCase() === selector) return item
  }
  return undefined
}

/** `JSON.stringify(matchedItem.outputs?.map(canon) ?? [])` per the spec —
 *  now always the true single matched item (see `matchedFunctionFor`), so
 *  this is exactly the spec's literal formula with no ambiguous-fallback
 *  branch needed. */
function canonicalOutputSignature(matched: AbiFunction): string {
  return JSON.stringify(matched.outputs?.map(canon) ?? [])
}

/**
 * Dedup key for `call`, or `undefined` when it must never be merged with
 * anything (see the module doc's "Eligibility" section for both reasons,
 * plus `matchedFunctionFor`'s defensive `undefined` case). Callers
 * (`src/core/engine.ts`) treat `undefined` identically regardless of WHICH
 * reason produced it: the call simply gets its own wire-list entry.
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
    const matched = matchedFunctionFor(call.abi, call.functionName, calldata)
    if (!matched) return undefined
    const signature = canonicalOutputSignature(matched)
    // External review (P2): lowercase `calldata` itself before keying — a
    // `bytes`/`bytesN` arg's ENCODED segment preserves the caller's own hex
    // casing verbatim (unlike an `address`, which viem/Solidity ABI-encodes
    // without checksum casing to begin with), so two calls with the same
    // bytes VALUE but different hex-string casing (`0xaAbB` vs `0xaabb`)
    // would otherwise key differently despite being byte-for-byte identical
    // calldata. Only the KEY is normalized here — the call's own `calldata`
    // value (and whatever the executor actually sends on the wire) is
    // completely untouched.
    return JSON.stringify([call.target.toLowerCase(), calldata.toLowerCase(), signature])
  } catch {
    return undefined
  }
}
