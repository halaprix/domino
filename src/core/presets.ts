/**
 * F7 — off-the-shelf `BatchOptions` bundles.
 *
 * `Presets.throughput` turns on every concurrency/dedup knob this release
 * train has shipped for the common "many independent contract reads, one
 * chain, one block" workload (e.g. resolving a portfolio of tokens/vaults):
 * concurrent batch dispatch (F6a, `maxConcurrentBatches`), adaptive
 * bisection (F6b, `adaptiveBatching`), and within-step cross-task dedup
 * (F7, `dedupe`).
 *
 * It deliberately does NOT set `batchSize`, `maxBatchAttempts`, or `block`
 * — spread it ahead of your own overrides:
 *
 * ```ts
 * await resolver.run(tasks, { ...Presets.throughput, batchSize: 200 })
 * ```
 *
 * `pinBlock` (F8) composes the same way — spread the preset, then add it:
 * `{ ...Presets.throughput, pinBlock: true }`.
 *
 * `dedupe: true` here can never change legacy-task semantics: dedup only
 * ever merges calls stamped dedup-ELIGIBLE (a compiled `TypedCallSpec` call,
 * eligible by default unless its spec set `dedupe: false`) — a
 * hand-authored legacy `MultistepTask`'s `StepCall`s carry no such stamp and
 * are therefore never merged, preset or not. See `BatchOptions.dedupe`'s
 * doc comment (`src/core/runMultistepTasks.ts`) for the full contract.
 */
export const Presets = {
  throughput: { maxConcurrentBatches: 5, adaptiveBatching: true, dedupe: true } as const,
}
