/**
 * G1 parity gate 2 — live mainnet fork test.
 *
 * Resolves a real ERC4626 vault (sDAI) and a real ERC20 token (USDC) through
 * BOTH the legacy oracle (`src/__tests__/fixtures/legacy-handlers/`) and the
 * new `defineTask`-based implementation (`src/handlers/`), via a real
 * `Eip1193Executor` talking to an actual RPC endpoint — `toStrictEqual`s the
 * two results against LIVE chain data, not mocks.
 *
 * **How to run:**
 * ```sh
 * RPC_URL=https://your-mainnet-rpc npm test -- --run src/__tests__/live/
 * ```
 *
 * Gated behind `describe.runIf(!!process.env.RPC_URL)` — CI has no RPC
 * secret configured, so this suite cleanly SKIPS (not fails) whenever
 * `RPC_URL` is unset, including in the default `npm test` run. The merge
 * gate for G1 is the offline parity fixtures (`src/__tests__/parity-g1.test.ts`);
 * this file is an additional, opt-in confidence check against real chain
 * state, run manually or in an environment with network egress.
 */

import { describe, it, expect } from 'vitest'
import { Eip1193Executor } from '../../engine/eip1193'
import { resolveErc20Token } from '../../handlers/erc20'
import { resolveErc4626Vault } from '../../handlers/erc4626'
import { buildErc20TaskLegacy } from '../fixtures/legacy-handlers/erc20'
import { buildErc4626TaskLegacy } from '../fixtures/legacy-handlers/erc4626'
import { runMultistepTasks } from '../../core/runMultistepTasks'
import type { Address, Eip1193Provider } from '../../core/types'

const RPC_URL = process.env['RPC_URL']

// Real mainnet contracts — sDAI (ERC4626) and USDC (ERC20).
const SDAI = '0x83F20F44975D03b1b09e64809B757c47f942BEeA' as Address
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4' as Address
// Any address works as an "owner" for this test — sDAI's maxWithdraw/maxRedeem
// and USDC's balanceOf both resolve to 0 for a non-holder, which is enough to
// exercise the with-owner code path identically on both sides.
const ZERO_OWNER = '0x0000000000000000000000000000000000000000' as Address

/** Minimal fetch-based EIP-1193 shim — JSON-RPC POST per `request()` call. */
function makeFetchProvider(url: string): Eip1193Provider {
  return {
    async request({ method, params }): Promise<unknown> {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params ?? [] }),
      })
      const body = (await res.json()) as { result?: unknown; error?: { message: string } }
      if (body.error) throw new Error(body.error.message)
      return body.result
    },
  }
}

describe.runIf(!!RPC_URL)('G1 live fork parity (RPC_URL set)', () => {
  it('resolveErc4626Vault (sDAI) : new impl matches legacy oracle against live chain state', async () => {
    const executor = new Eip1193Executor(makeFetchProvider(RPC_URL!))

    const fresh = await resolveErc4626Vault({ executor, vault: SDAI, owner: ZERO_OWNER })
    const [legacy] = await runMultistepTasks(executor, [
      buildErc4626TaskLegacy({ vault: SDAI, owner: ZERO_OWNER }),
    ])

    expect(fresh).toStrictEqual(legacy)
  })

  it('resolveErc20Token (USDC) : new impl matches legacy oracle against live chain state', async () => {
    const executor = new Eip1193Executor(makeFetchProvider(RPC_URL!))

    const fresh = await resolveErc20Token({ executor, token: USDC, owner: ZERO_OWNER })
    const [legacy] = await runMultistepTasks(executor, [
      buildErc20TaskLegacy({ token: USDC, owner: ZERO_OWNER }),
    ])

    expect(fresh).toStrictEqual(legacy)
  })
})
