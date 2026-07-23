/**
 * Global `unhandledRejection` guard (F6a, controller decision 6).
 *
 * Wired into BOTH `vitest.config.ts` and `vitest.compat-dist.config.ts` via
 * `test.setupFiles`, so it protects the entire suite — not just the new
 * concurrency tests. Any promise that rejects without a handler attached
 * anywhere in the process during a test run is collected here; `afterEach`
 * asserts nothing was collected and clears the list, failing whichever test
 * was running when the leak surfaced.
 *
 * This is the harness-side half of the fail-fast cancellation contract's
 * spec (b) ("in-flight batches ... their rejections attached (`.catch(noop)`)
 * so no unhandled rejections escape") — `src/core/pool.ts`'s design makes
 * that true by construction (every batch promise is awaited directly inside
 * its own worker's try/catch), and this guard is what actually PROVES it
 * across the test suite rather than merely asserting it in the design doc.
 */

import { afterEach } from 'vitest'

const leaked: unknown[] = []

function onUnhandledRejection(reason: unknown): void {
  leaked.push(reason)
}

process.on('unhandledRejection', onUnhandledRejection)

afterEach(() => {
  if (leaked.length === 0) return

  const captured = leaked.slice()
  leaked.length = 0

  const details = captured
    .map((reason, i) => {
      const label = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
      return `  [${i}] ${label}`
    })
    .join('\n')

  throw new Error(
    `${captured.length} unhandled rejection(s) leaked during this test:\n${details}`,
  )
})
