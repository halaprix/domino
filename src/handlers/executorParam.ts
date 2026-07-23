/**
 * F10: Executor/client parameter handling.
 * Shared across all handlers to maintain deprecation contract through 1.x.
 */

import type { StepExecutor } from '../core/types'

/**
 * Compile-time exclusive union: enforce either `executor:` (preferred) or `client:` (deprecated),
 * but not both. Used as: `ExecutorParam & { otherFields }` to create safe parameter objects.
 *
 * F10 design: `executor:` preferred, `client:` accepted with @deprecated JSDoc through all of 1.x;
 * passing both throws at runtime.
 */
export type ExecutorParam =
  | {
      executor: StepExecutor
      /** @deprecated Use `executor` instead — alias kept through all of 1.x. */
      client?: never
    }
  | {
      /** @deprecated Use `executor` instead — alias kept through all of 1.x. */
      client: StepExecutor
      executor?: never
    }

/**
 * Runtime guard: extract executor from params, ensuring exclusive union contract.
 * Throws if both or neither are provided.
 */
export function resolveExecutor(params: Record<string, unknown>): StepExecutor {
  if (params['executor'] !== undefined && params['client'] !== undefined) {
    throw new Error(
      "Pass either 'executor' or 'client', not both — they are aliases ('client' is deprecated)",
    )
  }
  const executor = (params['executor'] ?? params['client']) as StepExecutor | undefined
  if (executor === undefined) {
    throw new Error("Missing 'executor' or 'client' parameter")
  }
  return executor
}
