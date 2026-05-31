/**
 * Shared ABI fragments used across all engines and handlers.
 * Defined once here to eliminate duplication across handlers/ and engines/.
 *
 * Intended as `as const` so TypeScript infers literal types for viem's Abi parameter.
 */

/** Minimal ERC20 ABI — only the functions used by buildErc20Task and buildErc4626Task. */
export const erc20Abi = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
] as const

/** Minimal ERC4626 ABI — only the functions used by buildErc4626Task. */
export const erc4626Abi = [
  'function asset() view returns (address)',
  'function maxWithdraw(address) view returns (uint256)',
  'function maxRedeem(address) view returns (uint256)',
  'function convertToAssets(uint256) view returns (uint256)',
] as const

/**
 * Combined ERC20 + ERC4626 ABI — used as the default Interface for ethers engines.
 * Note: ethers executors don't use per-call `call.abi` — they encode via
 * `iface.encodeFunctionData(call.functionName, …)`. For custom MultistepTasks to
 * work on ethers, their functions must be present in this combined ABI.
 */
export const ercCombinedAbi = [...erc20Abi, ...erc4626Abi] as const
