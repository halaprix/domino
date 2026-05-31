import { type Address, erc20Abi } from "viem";
import type { Abi } from "viem";
import type { MultistepTask, StepCall, StepResult } from "../core/types";

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
  owner: Address | undefined;
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
