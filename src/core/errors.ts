/**
 * Error taxonomy for on-chain call failures resolved through the FSM executor.
 *
 * `DominoCallError` is the single error type domino constructs for a failed call.
 * The `kind` discriminates why the call failed; `data` and `cause` carry
 * different information depending on `kind` — see the table below. They are
 * separate fields (never conflated) because decode failures need BOTH the raw
 * bytes that failed to decode AND the decoder exception that explains why.
 *
 * | kind      | `data`                                    | `cause`                    |
 * |-----------|--------------------------------------------|----------------------------|
 * | `revert`  | returnData (revert selector inspectable)   | —                          |
 * | `decode`  | raw bytes that failed to decode            | the decode error           |
 * | `batch`   | —                                           | provider/transport error   |
 * | `skipped` | —                                           | upstream `DominoCallError` |
 * | `derive`  | —                                           | thrown value               |
 *
 * Only `revert` and `decode` are constructed by domino itself as of 1.1 (see
 * `Eip1193Executor#decodeResults`). `batch`, `skipped`, and `derive` are part
 * of the taxonomy's public surface but are wired up by later features
 * (runSettled, defineTask, bisection).
 */

import type { Address } from './types'

/** Discriminates why a call failed. See the field-usage table above. */
export type DominoCallErrorKind = 'revert' | 'decode' | 'batch' | 'skipped' | 'derive'

/** Options accepted by the {@link DominoCallError} constructor. */
export interface DominoCallErrorOptions {
  kind: DominoCallErrorKind
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

/**
 * Structured error carried by a failed call.
 *
 * Extends the platform `Error` so `instanceof Error` and the standard `cause`
 * chain (stack traces included) keep working for consumers who don't know
 * about `DominoCallError` specifically.
 */
export class DominoCallError extends Error {
  declare readonly kind: DominoCallErrorKind
  declare readonly data?: `0x${string}`
  declare readonly target?: Address
  declare readonly functionName?: string
  declare readonly key?: string

  constructor(message: string, opts: DominoCallErrorOptions) {
    // Standard Error cause chain — never discard provider/decode stacks.
    //
    // Must NOT pass `{ cause: opts.cause }` unconditionally: per ES2022,
    // ErrorOptions installs an own `cause` property whenever the `cause` key
    // is present on the options object, even when its value is `undefined`.
    // That would give every no-cause DominoCallError (e.g. `revert`, whose
    // taxonomy row has no cause) an own `cause: undefined` property, which
    // is observably different from "no cause at all" (`Object.hasOwn` would
    // wrongly report true). Only pass the options object when a cause was
    // actually supplied.
    //
    // Accepted trade-off: a future `derive` kind wrapping a literal
    // `throw undefined` would be indistinguishable from "no cause supplied"
    // — both omit the own `cause` property. This is fine; `derive` always
    // has SOME thrown value in practice, and `throw undefined` is itself
    // pathological.
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined)
    this.name = 'DominoCallError'
    this.kind = opts.kind
    // exactOptionalPropertyTypes-safe: only assign optional fields when provided,
    // so an omitted field is genuinely absent (`'data' in err === false`) rather
    // than present-with-value-undefined.
    if (opts.data !== undefined) this.data = opts.data
    if (opts.target !== undefined) this.target = opts.target
    if (opts.functionName !== undefined) this.functionName = opts.functionName
    if (opts.key !== undefined) this.key = opts.key
  }
}
