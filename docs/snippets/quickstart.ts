/**
 * Quickstart — checked in CI against the built dist types (see D4 / scripts/check-snippets.ts).
 *
 * Demonstrates the three layers of the public API:
 *   1. resolveErc4626Vault  — direct handler-layer call
 *   2. MulticallResolver    — convenience layer wrapping an executor
 *   3. runMultistepTasks    — bare-metal FSM, for fully custom tasks
 */
import { createPublicClient, http } from 'viem'
import { mainnet } from 'viem/chains'
import {
  Eip1193Executor,
  MulticallResolver,
  resolveErc4626Vault,
  runMultistepTasks,
} from '@halaprix/domino'
import type { MultistepTask } from '@halaprix/domino'

const provider = createPublicClient({ chain: mainnet, transport: http() })
const executor = new Eip1193Executor(provider)

const VAULT = '0x0000000000000000000000000000000000000000'
const OWNER = '0x0000000000000000000000000000000000000001'

async function quickstart() {
  // 1. Direct handler-layer call.
  const vault = await resolveErc4626Vault({ client: executor, vault: VAULT, owner: OWNER })
  console.log(vault.metadata.symbol, vault.position?.assets)

  // 2. Convenience resolver layer.
  const resolver = new MulticallResolver(executor)
  const same = await resolver.resolveErc4626({ vault: VAULT, owner: OWNER })
  console.log(same.metadata.decimals)

  // Historical block query — works the same way at every layer.
  const old = await resolveErc4626Vault({
    client: executor,
    vault: VAULT,
    owner: OWNER,
    block: { blockNumber: 19_000_000n },
  })
  console.log(old.metadata.underlyingAsset)

  // 3. Bare-metal FSM — for fully custom MultistepTask pipelines.
  const results = await runMultistepTasks(executor, [] as MultistepTask<unknown>[])
  console.log(results.length)
}

void quickstart()
