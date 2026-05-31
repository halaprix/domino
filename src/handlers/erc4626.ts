import {
  type Address,
  type PublicClient,
  erc20Abi,
  erc4626Abi,
} from "viem";
import type { Abi } from "viem";
import { type MultistepTask, runMultistepTasks } from "../multistepMulticall";

type Erc4626Context = {
  symbol?: string;
  decimals?: number;
  balance?: bigint;
  maxWithdraw?: bigint;
  maxRedeem?: bigint;
  underlyingAsset?: Address;
  assets?: bigint;
};

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

type Erc4626Task = MultistepTask<Erc4626VaultResolution>;

function buildErc4626Task(params: {
  vault: Address;
  owner: Address | undefined;
}): Erc4626Task {
  const { vault, owner } = params;
  const ctx: Erc4626Context = {};
  const hasOwner = !!owner;

  const task: Erc4626Task = {
    maxStep: hasOwner ? 2 : 1,

    buildStepCalls(step) {
      if (step === 1) {
        const calls: {
          key: string;
          target: Address;
          abi: Abi;
          functionName: string;
          args?: readonly unknown[];
        }[] = [
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
        // Only execute step 2 if we have a balance from step 1
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

/**
 * Resolve ERC4626 vault metadata and optionally position for an owner.
 *
 * Without owner:
 * - Step 1: symbol, decimals, asset()
 *
 * With owner:
 * - Step 1: symbol, decimals, asset(), balanceOf(owner), maxWithdraw(owner), maxRedeem(owner)
 * - Step 2: convertToAssets(balance) — depends on step 1 balance
 */
export async function resolveErc4626Vault(params: {
  client: PublicClient;
  vault: Address;
  owner?: Address;
}): Promise<Erc4626VaultResolution> {
  const { client, vault, owner } = params;
  const task = buildErc4626Task({ vault, owner: owner ?? undefined });
  const [resolution] = await runMultistepTasks(client, [task]);
  return resolution!;
}

/**
 * Resolve multiple ERC4626 vaults in a single multicall pipeline.
 *
 * All vaults' step 1 calls are batched into one multicall.
 * All vaults' step 2 calls are batched into a second multicall.
 * Total: 2 RPC calls regardless of vault count.
 */
export async function resolveErc4626VaultsBulk(params: {
  client: PublicClient;
  entries: { vault: Address; owner?: Address }[];
}): Promise<Erc4626VaultResolution[]> {
  const { client, entries } = params;
  if (entries.length === 0) return [];

  const tasks = entries.map((entry) =>
    buildErc4626Task({ vault: entry.vault, owner: entry.owner }),
  );
  return runMultistepTasks(client, tasks);
}