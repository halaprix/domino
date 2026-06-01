/**
 * Live benchmark: real Multicall3 calls to measure batchSize impact on latency.
 *
 * Two experiments:
 *   1. Batch-size sweep  — 50 ERC20 tokens (100 calls), varying batchSize from
 *      10 → "all-in-one". Shows exactly where extra round-trips stop costing time.
 *   2. Limit probe — one giant Multicall3 call with N identical calls, scaling
 *      N from 100 → 5000, reveals the practical ceiling before the RPC errors
 *      or times out. Stops at first failure.
 *
 * Usage:
 *   RPC_URL=https://eth-mainnet.g.alchemy.com/v2/KEY npm run benchmark:live
 *   RPC_URL=... PUBLIC_RPC_URL=https://eth.llamarpc.com npm run benchmark:live
 */

import { createPublicClient, http, type Abi } from 'viem'
import { mainnet } from 'viem/chains'
import { runMultistepTasks } from '../src/core/runMultistepTasks'
import { buildErc20Task } from '../src/handlers/erc20'
import { erc20Abi } from '../src/abis/erc'
import type { StepCall, StepExecutor, Address, RawResult } from '../src/core/types'

// ---------------------------------------------------------------------------
// 50 reliable mainnet ERC20 tokens — all have standard symbol() + decimals()
// ---------------------------------------------------------------------------

const TOKENS_50: Address[] = [
  '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
  '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
  '0xdAC17F958D2ee523a2206206994597C13D831ec7', // USDT
  '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', // WBTC
  '0x514910771AF9Ca656af840dff83E8264EcF986CA', // LINK
  '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9', // AAVE
  '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', // UNI
  '0x6B175474E89094C44Da98b954EedeAC495271d0F', // DAI
  '0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6f', // SNX
  '0xD533a949740bb3306d119CC777fa900bA034cd52', // CRV
  '0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32', // LDO
  '0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B', // CVX
  '0xba100000625a3754423978a60c9317c58a424e3D', // BAL
  '0xc944E90C64B2c07662A292be6244BDf05Cda44a7', // GRT
  '0xc00e94Cb662C3520282E6f5717214004A7f26888', // COMP
  '0x0bc529c00C6401aEF6D220BE8C6Ea1667F6Ad93e', // YFI
  '0x6B3595068778DD592e39A122f4f5a5cF09C90fE2', // SUSHI
  '0x111111111117dC0aa78b770fA6A738034120C302', // 1INCH
  '0xE41d2489571d322189246DaFA5ebDe1F4699F498', // ZRX
  '0x0D8775F648430679A709E98d2b0Cb6250d2887EF', // BAT
  '0x0F5D2fB29fb7d3CFeE444a200298f468908cC942', // MANA
  '0xF629cBd94d3791C9250152BD8dfBDF380E2a3B9c', // ENJ
  '0x3845badAde8e6dFF049820680d1F14bD3903a5d0', // SAND
  '0xBB0E17EF65F82Ab018d8EDd776e8DD940327B28b', // AXS
  '0xF57e7e7C23978C3cAEC3C3548E3D615c346e79fF', // IMX
  '0x3432B6A60D23Ca0dFCa7761B7ab56459D9C964D0', // FXS
  '0x853d955aCEf822Db058eb8505911ED77F175b99e', // FRAX
  '0xD33526068D116cE69F19A9ee46F0bd304F21A51f', // RPL
  '0xBBbbCA6A901c926F240b89EacB641d8Aec7AEafD', // LRC
  '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84', // stETH
  '0xae78736Cd615f374D3085123A210448E74Fc6393', // rETH
  '0xBe9895146f7AF43049ca1c1AE358B0541Ea49704', // cbETH
  '0x808507121B80c02388fAd14726482e061B8da827', // PENDLE
  '0xec53bF9167f50cDEB3Ae105f56099aaaB9061F83', // EIGEN
  '0xFe0c30065B384F05761f15d0CC899D4F9F9Cc0eB', // ETHFI
  '0x57e114B691Db790C35207b2e685D4A43181e6061', // ENA
  '0x163f8C2467924be0ae7B5347228CABF260318753', // WLD
  '0x5283D291DBCF85356A21bA090E6db59121208b44', // BLUR
  '0x6De037ef9aD2725EB40118Bb1702EBb27e4Aeb24', // RNDR
  '0x6982508145454Ce325dDbE47a25d4ec3d2311933', // PEPE
  '0xcf0C122c6b73ff809C693DB761e7BaeBe62b6a2E', // FLOKI
  '0xC18360217D8F7Ab5e7c516566761Ea12Ce7F9D72', // ENS
  '0x04Fa0d235C4abf4BcF4787aF4CF447DE572eF828', // UMA
  '0x967da4048cD07aB37855c090aAF366e4ce1b9F48', // OCEAN
  '0x0b38210ea11411557c13457D4dA7dC6ea731B88a', // API3
  '0x45804880De22913dAFE09f4980848ECE6EcbAf78', // PAXG
  '0x5f98805A4E8be255a32880FDeC7F6728C6568bA0', // LUSD
  '0xAf5191B0De278C7286d6C7CC6ab6BB8A73bA2Cd6', // STG
  '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', // wstETH
  '0xA35b1B31Ce002FBF2058D22F30f95D405200A15b', // ETHx
]

// Token used for the limit probe (simple, reliable, no proxy weirdness)
const PROBE_TOKEN: Address = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' // USDC

// ---------------------------------------------------------------------------
// Live executor — wraps PublicClient.multicall, records per-batch timing
// ---------------------------------------------------------------------------

interface BatchRecord {
  size: number
  wallMs: number
}

interface LiveExecutor extends StepExecutor {
  getBatches(): BatchRecord[]
  reset(): void
}

function createLiveExecutor(rpcUrl: string): LiveExecutor {
  const batches: BatchRecord[] = []

  const client = createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl, { timeout: 60_000 }),
  })

  return {
    async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
      const start = performance.now()
      const contracts = calls.map((call) => ({
        address: call.target,
        abi: call.abi as Abi,
        functionName: call.functionName,
        args: call.args ?? [],
      }))

      const results = await client.multicall({
        contracts: contracts as Parameters<typeof client.multicall>[0]['contracts'],
        allowFailure: true,
      })

      batches.push({ size: calls.length, wallMs: Math.round(performance.now() - start) })

      return results.map((r) =>
        r.status === 'failure'
          ? { status: 'failure' as const }
          : { status: 'success' as const, value: r.result },
      )
    },

    getBatches() {
      return [...batches]
    },

    reset() {
      batches.length = 0
    },
  }
}

// ---------------------------------------------------------------------------
// Batch-size sweep
// ---------------------------------------------------------------------------

interface SweepRow {
  batchSize: number | 'all'
  batchCount: number
  totalCalls: number
  wallMs: number
  callsPerSec: number
  note: string
}

async function runSweep(
  rpcUrl: string,
  tokens: Address[],
): Promise<SweepRow[]> {
  const totalCalls = tokens.length * 2 // symbol + decimals per token
  // Sweep from small → large, ending with "all in one" (batchSize ≥ totalCalls)
  const batchSizes = [10, 25, 50, 75, 100, 150, 200, totalCalls]
  const rows: SweepRow[] = []

  for (const batchSize of batchSizes) {
    const executor = createLiveExecutor(rpcUrl)
    const tasks = tokens.map((token) => buildErc20Task({ token }))

    const start = performance.now()
    await runMultistepTasks(executor, tasks, { batchSize })
    const wallMs = Math.round(performance.now() - start)

    const batchRecords = executor.getBatches()
    const callsPerSec = Math.round(totalCalls / (wallMs / 1000))
    const isAllInOne = batchSize >= totalCalls

    rows.push({
      batchSize: isAllInOne ? 'all' : batchSize,
      batchCount: batchRecords.length,
      totalCalls,
      wallMs,
      callsPerSec,
      note: '',
    })

    // Pause between requests to avoid rate-limiting
    await pause(600)
  }

  // Annotate the sweet spot: smallest batchSize that achieves 1 batch
  const sweetSpotIdx = rows.findIndex((r) => r.batchCount === 1)
  if (sweetSpotIdx >= 0) {
    rows[sweetSpotIdx]!.note = '← sweet spot'
  }

  return rows
}

function printSweepTable(label: string, rows: SweepRow[]): void {
  console.log(`\n  ${label}`)
  const colW = [12, 9, 12, 10, 12, 18]
  const headers = ['batchSize', 'batches', 'total calls', 'wall ms', 'calls/sec', 'note']
  const sep = colW.map((w) => '─'.repeat(w)).join('┼')

  console.log('  ┌' + sep + '┐')
  console.log(
    '  │' + headers.map((h, i) => h.padEnd(colW[i]!)).join('│') + '│',
  )
  console.log('  ├' + sep + '┤')

  for (const row of rows) {
    const cells = [
      String(row.batchSize).padEnd(colW[0]!),
      String(row.batchCount).padEnd(colW[1]!),
      String(row.totalCalls).padEnd(colW[2]!),
      String(row.wallMs).padEnd(colW[3]!),
      String(row.callsPerSec).padEnd(colW[4]!),
      row.note.padEnd(colW[5]!),
    ]
    console.log('  │' + cells.join('│') + '│')
  }

  console.log('  └' + sep + '┘')
}

// ---------------------------------------------------------------------------
// Limit probe — one direct Multicall3 call with N identical calls
// ---------------------------------------------------------------------------

interface ProbeResult {
  size: number
  wallMs: number
  success: boolean
  error?: string
}

async function runLimitProbe(rpcUrl: string): Promise<ProbeResult[]> {
  const client = createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl, { timeout: 60_000 }),
  })

  const probeSizes = [100, 200, 500, 1000, 2000, 5000]
  const results: ProbeResult[] = []

  for (const size of probeSizes) {
    process.stdout.write(`    probing ${size} calls... `)

    const contracts = Array.from({ length: size }, () => ({
      address: PROBE_TOKEN,
      abi: erc20Abi as Abi,
      functionName: 'symbol',
      args: [],
    }))

    try {
      const start = performance.now()
      await client.multicall({
        contracts: contracts as Parameters<typeof client.multicall>[0]['contracts'],
        allowFailure: true,
      })
      const wallMs = Math.round(performance.now() - start)
      console.log(`${wallMs}ms ✓`)
      results.push({ size, wallMs, success: true })
      await pause(1000)
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 100) : String(err)
      console.log(`FAILED — ${msg}`)
      results.push({ size, wallMs: 0, success: false, error: msg })
      break
    }
  }

  return results
}

function printProbeTable(results: ProbeResult[]): void {
  const colW = [10, 10, 10, 30]
  const headers = ['calls', 'wall ms', 'status', 'error']
  const sep = colW.map((w) => '─'.repeat(w)).join('┼')

  console.log('  ┌' + sep + '┐')
  console.log('  │' + headers.map((h, i) => h.padEnd(colW[i]!)).join('│') + '│')
  console.log('  ├' + sep + '┤')

  for (const r of results) {
    const cells = [
      String(r.size).padEnd(colW[0]!),
      (r.success ? String(r.wallMs) : '—').padEnd(colW[1]!),
      (r.success ? '✓ ok' : '✗ fail').padEnd(colW[2]!),
      (r.error ?? '').slice(0, colW[3]! - 1).padEnd(colW[3]!),
    ]
    console.log('  │' + cells.join('│') + '│')
  }

  console.log('  └' + sep + '┘')
}

// ---------------------------------------------------------------------------
// Recommendation
// ---------------------------------------------------------------------------

function printRecommendation(
  rpcLabel: string,
  sweepRows: SweepRow[],
  probeResults: ProbeResult[],
): void {
  const sweetSpot = sweepRows.find((r) => r.batchCount === 1 && r.batchSize !== 'all')
  const lastOk = [...probeResults].reverse().find((r) => r.success)
  const firstFail = probeResults.find((r) => !r.success)

  console.log(`\n  Recommendations for ${rpcLabel}:`)

  if (sweetSpot) {
    console.log(
      `    Sweet spot:   batchSize ≥ ${sweetSpot.batchSize} fits your ${sweetSpot.totalCalls}-call workload in 1 round-trip (~${sweetSpot.wallMs}ms)`,
    )
  }

  if (lastOk) {
    const verb = firstFail ? 'last success' : 'no failures up to'
    console.log(`    Probe limit:  ${verb} ${lastOk.size} calls/batch (${lastOk.wallMs}ms)`)
  }

  if (firstFail) {
    console.log(`    Hard ceiling: ${firstFail.size} calls failed — stay below this`)
  } else {
    console.log(`    Hard ceiling: not reached (tested up to ${probeResults.at(-1)?.size ?? '?'})`)
  }

  const suggested =
    sweetSpot != null
      ? sweetSpot.batchSize
      : lastOk != null
        ? Math.min(lastOk.size, 500)
        : 100

  console.log(`\n    → Suggested batchSize for ${rpcLabel}: ${suggested}`)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function hr(): void {
  console.log('\n' + '─'.repeat(72))
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const rpcUrl = process.env['RPC_URL']
  const publicRpcUrl = process.env['PUBLIC_RPC_URL']

  if (!rpcUrl) {
    console.error(
      '\nError: RPC_URL environment variable is required.\n\n' +
        '  RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY npm run benchmark:live\n\n' +
        'Optionally add PUBLIC_RPC_URL for an RPC comparison:\n' +
        '  PUBLIC_RPC_URL=https://eth.llamarpc.com\n',
    )
    process.exit(1)
  }

  console.log('\n━━━  multistep-multicall live benchmark  ━━━\n')
  console.log(`  Tokens:       ${TOKENS_50.length} (${TOKENS_50.length * 2} calls per step)`)
  console.log(`  RPC:          ${rpcUrl.replace(/\/[a-zA-Z0-9_-]{20,}/, '/***')}`)
  if (publicRpcUrl) {
    console.log(`  Public RPC:   ${publicRpcUrl}`)
  }

  // ── Primary RPC ──────────────────────────────────────────────────────────

  hr()
  console.log('\n1. Batch-size sweep (primary RPC)\n')
  console.log('  Running...')
  const sweepRows = await runSweep(rpcUrl, TOKENS_50)
  printSweepTable('Primary RPC', sweepRows)

  hr()
  console.log('\n2. Limit probe (primary RPC) — single Multicall3 call with N calls\n')
  const probeResults = await runLimitProbe(rpcUrl)
  printProbeTable(probeResults)

  printRecommendation('primary RPC', sweepRows, probeResults)

  // ── Public RPC (optional) ────────────────────────────────────────────────

  if (publicRpcUrl) {
    hr()
    console.log('\n3. Batch-size sweep (public RPC)\n')
    console.log('  Running...')
    const publicSweepRows = await runSweep(publicRpcUrl, TOKENS_50)
    printSweepTable('Public RPC', publicSweepRows)

    hr()
    console.log('\n4. Limit probe (public RPC)\n')
    const publicProbeResults = await runLimitProbe(publicRpcUrl)
    printProbeTable(publicProbeResults)

    printRecommendation('public RPC', publicSweepRows, publicProbeResults)

    // ── Comparison summary ────────────────────────────────────────────────
    hr()
    console.log('\n5. RPC comparison\n')

    const primarySweet = sweepRows.find((r) => r.batchCount === 1 && r.batchSize !== 'all')
    const publicSweet = publicSweepRows.find((r) => r.batchCount === 1 && r.batchSize !== 'all')

    if (primarySweet && publicSweet) {
      const speedup = (publicSweet.wallMs / primarySweet.wallMs).toFixed(1)
      console.log(
        `  At sweet-spot batchSize=${primarySweet.batchSize}: primary ${primarySweet.wallMs}ms vs public ${publicSweet.wallMs}ms (${speedup}× slower)`,
      )
    }

    const primaryOk = [...probeResults].reverse().find((r) => r.success)
    const publicOk = [...publicProbeResults].reverse().find((r) => r.success)
    if (primaryOk && publicOk) {
      console.log(
        `  Max probe (no failure): primary ${primaryOk.size} calls @ ${primaryOk.wallMs}ms, public ${publicOk.size} calls @ ${publicOk.wallMs}ms`,
      )
    }
  }

  hr()
  console.log('\nDone.\n')
}

main().catch((err: unknown) => {
  console.error('\nFatal error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
