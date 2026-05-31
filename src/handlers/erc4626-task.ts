import { type Address, erc20Abi, erc4626Abi } from "viem";
import type { Abi } from "viem";
import type { MultistepTask, StepCall } from "../core/types";
import type { StepExecutor } from "../core/runMultistepTasks";

export interface Erc4626VaultResolution {
  metadata: {
    symbol: string | undefined;
    decimals: number | undefined;
    underlyingAsset: Address | undefined;
    maxWithdraw: bigint | undefined;
    maxRedeem: bigint | undefined;
  };
  position:
    | {
        balance: bigint | undefined;
        assets: bigint | undefined;
      }
    | undefined;
}

type Erc4626Context = {
  symbol?: string;
  decimals?: number;
  balance?: bigint;
  maxWithdraw?: bigint;
  maxRedeem?: bigint;
  underlyingAsset?: Address;
  assets?: bigint;
};

export function buildErc4626Task(
  executor: StepExecutor,
  params: { vault: Address; owner?: Address },
): MultistepTask<Erc4626VaultResolution> {
  const { vault, owner } = params;
  const ctx: Erc4626Context = {};
  const hasOwner = !!owner;

  const task: MultistepTask<Erc4626VaultResolution> = {
    maxStep: hasOwner ? 2 : 1,

    buildStepCalls(step) {
      if (step === 1) {
        const calls: StepCall[] = [
          {
            key: "symbol",
            target: vault,
            abi: erc20Abi as Abi,
            functionName: "symbol",
          },
          {
            key: "decimals",
            target: vault,
            abi: erc20Abi as Abi,
            functionName: "decimals",
          },
          {
            key: "asset",
            target: vault,
            abi: erc4626Abi as Abi,
            functionName: "asset",
          },
        ];

        if (hasOwner && owner) {
          calls.push(
            {
              key: "balance",
              target: vault,
              abi: erc20Abi as Abi,
              functionName: "balanceOf",
              args: [owner],
            },
            {
              key: "maxWithdraw",
              target: vault,
              abi: erc4626Abi as Abi,
              functionName: "maxWithdraw",
              args: [owner],
            },
            {
              key: "maxRedeem",
              target: vault,
              abi: erc4626Abi as Abi,
              functionName: "maxRedeem",
              args: [owner],
            },
          );
        }

        return calls;
      }

      if (step === 2 && hasOwner) {
        if (ctx.balance === undefined) {
          return [];
        }
        return [
          {
            key: "assets",
            target: vault,
            abi: erc4626Abi as Abi,
            functionName: "convertToAssets",
            args: [ctx.balance],
          },
        ];
      }

      return [];
    },

    consumeStepResults(step, results) {
      for (const result of results) {
        if (step === 1) {
          if (result.key === "symbol") {
            ctx.symbol = result.value as string;
          }
          if (result.key === "decimals") {
            ctx.decimals = Number(result.value as bigint);
          }
          if (result.key === "asset") {
            ctx.underlyingAsset = result.value as Address;
          }
          if (hasOwner) {
            if (result.key === "balance") {
              ctx.balance = BigInt(result.value as string);
            }
            if (result.key === "maxWithdraw") {
              ctx.maxWithdraw = BigInt(result.value as string);
            }
            if (result.key === "maxRedeem") {
              ctx.maxRedeem = BigInt(result.value as string);
            }
          }
        }

        if (step === 2 && result.key === "assets") {
          ctx.assets = BigInt(result.value as string);
        }
      }
    },

    finalize() {
      return {
        metadata: {
          symbol: ctx.symbol,
          decimals: ctx.decimals,
          underlyingAsset: ctx.underlyingAsset,
          maxWithdraw: ctx.maxWithdraw,
          maxRedeem: ctx.maxRedeem,
        },
        position: hasOwner
          ? {
              balance: ctx.balance,
              assets: ctx.assets,
            }
          : undefined,
      };
    },
  };

  return task;
}
