/**
 * ERC20 handler — framework-agnostic task builder + convenience functions.
 *
 * Builds a MultistepTask that resolves ERC20 token metadata (symbol, decimals)
 * and optionally an owner's balance.
 *
 * Single-step task:
 *   Step 1: symbol(), decimals(), balanceOf(owner?)
 */

import type { Address, MultistepTask, StepCall, StepResult, StepExecutor } from "../core/types";
import { runMultistepTasks } from "../core/runMultistepTasks";
import { ViemExecutor } from "../engines/ViemExecutor";

/** Minimal ERC20 ABI — only the functions used by buildErc20Task. */
const erc20Abi = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
] as const;

export interface Erc20TokenResolution {
  symbol: string | undefined;
  decimals: number | undefined;
  balance: bigint | undefined;
}

type Erc20Context = {
  symbol?: string;
  decimals?: number;
  balance?: bigint;
};

export function buildErc20Task(params: {
  token: Address;
  owner?: Address;
}): MultistepTask<Erc20TokenResolution> {
  const { token, owner } = params;
  const ctx: Erc20Context = {};
  const hasOwner = !!owner;

  return {
    maxStep: 1,

    buildStepCalls(step) {
      if (step !== 1) return [];

      const calls: StepCall[] = [
        {
          key: "symbol",
          target: token,
          abi: erc20Abi,
          functionName: "symbol",
        },
        {
          key: "decimals",
          target: token,
          abi: erc20Abi,
          functionName: "decimals",
        },
      ];

      if (hasOwner && owner) {
        calls.push({
          key: "balance",
          target: token,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [owner],
        });
      }

      return calls;
    },

    consumeStepResults(_step, results: StepResult[]) {
      for (const result of results) {
        if (result.key === "symbol") {
          ctx.symbol = result.value as string;
        }
        if (result.key === "decimals") {
          ctx.decimals = Number(result.value as bigint);
        }
        if (result.key === "balance") {
          ctx.balance = BigInt(result.value as string);
        }
      }
    },

    finalize() {
      return {
        symbol: ctx.symbol,
        decimals: ctx.decimals,
        balance: ctx.balance,
      };
    },
  };
}

/** Coerce to StepExecutor — wraps PublicClient in ViemExecutor if needed. */
function toExecutor(client: StepExecutor): StepExecutor {
  return client;
}

export async function resolveErc20Token(params: {
  client: StepExecutor;
  token: Address;
  owner?: Address;
}): Promise<Erc20TokenResolution> {
  const executor = toExecutor(params.client);
  const taskParams: { token: Address; owner?: Address } = { token: params.token };
  if (params.owner !== undefined) taskParams.owner = params.owner;
  const [result] = await runMultistepTasks(executor, [buildErc20Task(taskParams)]);
  return result!;
}

export async function resolveErc20TokensBulk(params: {
  client: StepExecutor;
  entries: { token: Address; owner?: Address }[];
}): Promise<Erc20TokenResolution[]> {
  if (params.entries.length === 0) return [];
  const executor = toExecutor(params.client);
  const tasks = params.entries.map((e) => {
    return e.owner !== undefined
      ? buildErc20Task({ token: e.token, owner: e.owner as Address })
      : buildErc20Task({ token: e.token });
  });
  return runMultistepTasks(executor, tasks);
}
