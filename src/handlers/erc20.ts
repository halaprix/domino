import { type Address, type PublicClient, erc20Abi } from "viem";
import type { Abi } from "viem";
import { type MultistepTask, runMultistepTasks } from "../multistepMulticall";

type Erc20Context = {
  symbol?: string;
  decimals?: number;
  balance?: bigint;
};

export interface ResolvedErc20Token {
  symbol: string | undefined;
  decimals: number | undefined;
  balance: bigint | undefined;
}

type Erc20Task = MultistepTask<ResolvedErc20Token>;

function buildErc20Task(params: {
  token: Address;
  owner: Address | undefined;
}): Erc20Task {
  const { token, owner } = params;
  const ctx: Erc20Context = {};
  const hasOwner = !!owner;

  const task: Erc20Task = {
    maxStep: 1,

    buildStepCalls(step) {
      if (step !== 1) return [];

      const calls: {
        key: string;
        target: Address;
        abi: Abi;
        functionName: string;
        args?: readonly unknown[];
      }[] = [
        {
          key: "symbol",
          target: token,
          abi: erc20Abi as Abi,
          functionName: "symbol",
        },
        {
          key: "decimals",
          target: token,
          abi: erc20Abi as Abi,
          functionName: "decimals",
        },
      ];

      if (hasOwner && owner) {
        calls.push({
          key: "balance",
          target: token,
          abi: erc20Abi as Abi,
          functionName: "balanceOf",
          args: [owner],
        });
      }

      return calls;
    },

    consumeStepResults(step, results) {
      if (step !== 1) return;

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

  return task;
}

/**
 * Resolve ERC20 token metadata and optionally balance for an owner.
 *
 * Single-step task:
 * - symbol(), decimals(), balanceOf(owner?)
 */
export async function resolveErc20Token(params: {
  client: PublicClient;
  token: Address;
  owner: Address | undefined;
}): Promise<ResolvedErc20Token> {
  const { client, token, owner } = params;
  const task = buildErc20Task({ token, owner });
  const [resolution] = await runMultistepTasks(client, [task]);
  return resolution!;
}

/**
 * Resolve multiple ERC20 tokens in a single multicall.
 *
 * All tokens' step 1 calls are batched into one multicall.
 */
export async function resolveErc20TokensBulk(params: {
  client: PublicClient;
  entries: { token: Address; owner?: Address }[];
}): Promise<ResolvedErc20Token[]> {
  const { client, entries } = params;
  if (entries.length === 0) return [];
  const tasks = entries.map((entry) =>
    buildErc20Task({ token: entry.token, owner: entry.owner ?? undefined }),
  );
  return runMultistepTasks(client, tasks);
}
