/**
 * Shared ABI fragments used across all engines and handlers.
 * Defined once here to eliminate duplication across handlers/ and engines/.
 *
 * Stored as JSON ABI objects (not human-readable strings) because viem's
 * `multicall`/`encodeFunctionData` require parsed ABI items. ethers' `Interface`
 * accepts the same JSON ABI, so a single representation works for every engine.
 * `as const` lets TypeScript infer literal types for viem's `Abi` parameter.
 */

/** Minimal ERC20 ABI — only the functions used by buildErc20Task and buildErc4626Task. */
export const erc20Abi = [
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const

/** Minimal ERC4626 ABI — only the functions used by buildErc4626Task. */
export const erc4626Abi = [
  {
    type: 'function',
    name: 'asset',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'maxWithdraw',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'maxRedeem',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'convertToAssets',
    stateMutability: 'view',
    inputs: [{ name: 'shares', type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
  },
] as const

/**
 * Combined ERC20 + ERC4626 ABI — used as the default Interface for ethers engines.
 * Note: ethers executors don't use per-call `call.abi` — they encode via
 * `iface.encodeFunctionData(call.functionName, …)`. For custom MultistepTasks to
 * work on ethers, their functions must be present in this combined ABI.
 */
export const ercCombinedAbi = [...erc20Abi, ...erc4626Abi] as const
