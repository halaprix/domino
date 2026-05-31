/**
 * MultistepTask abstract base class.
 *
 * Provides common state management and step orchestration logic.
 * Concrete tasks extend this class and implement buildStepCalls,
 * consumeStepResults, and finalize.
 */

import type { MultistepTask, StepResult } from "./types";

/**
 * Result type placeholder — override in subclass.
 */
export type TaskResult<T> = T;

export abstract class MultistepTaskBase<TResult>
  implements MultistepTask<TResult>
{
  /** Current step counter — incremented by runMultistepTasks. */
  protected currentStep = 0;

  /** Internal context accumulated across steps. */
  protected context: Record<string, unknown> = {};

  abstract readonly maxStep: number;

  abstract buildStepCalls(step: number): import("./types").StepCall[];
  abstract consumeStepResults(step: number, results: StepResult[]): void;
  abstract finalize(): TResult;

  /** Override to return current context for inspection. */
  getContext(): Record<string, unknown> {
    return { ...this.context };
  }

  /**
   * Helper: store a value in context by key.
   * Subclasses use this in consumeStepResults.
   */
  protected set(key: string, value: unknown): void {
    this.context[key] = value;
  }

  /**
   * Helper: retrieve a value from context by key.
   * Subclasses use this in buildStepCalls to gate step 2 on step 1 results.
   */
  protected get<T = unknown>(key: string): T | undefined {
    return this.context[key] as T | undefined;
  }
}