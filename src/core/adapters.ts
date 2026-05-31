/**
 * Shared adapter utilities — bridge between public API (accepting PublicClient)
 * and internal framework (StepExecutor).
 */

import type { PublicClient } from "viem";
import type { StepExecutor } from "./types";

/**
 * Returns client as-is if it already implements StepExecutor,
 * otherwise wraps it (for future extensibility).
 */
export function toExecutor(client: StepExecutor | PublicClient): StepExecutor {
  if ("executeMulticall" in client) {
    return client;
  }
  // Default: client is a viem PublicClient — must be wrapped by engine.
  // Import ViemExecutor from engines/viem at the call site to avoid circular deps.
  throw new Error(
    "PublicClient requires engine-specific wrapper. " +
    "Import ViemExecutor from '../engines/viem' and wrap before passing.",
  );
}
