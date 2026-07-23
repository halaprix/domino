/**
 * G2 — Aave v3 + Spark + Morpho Blue refinance-rate example (v1.3.0 release
 * gate: "the proof the whole 1.x surface composes on real protocols").
 *
 * Checked in CI against the BUILT dist types, exactly like `docs/snippets/*`
 * (see `scripts/check-snippets.ts`) — that type-check is the merge gate.
 * `main()` only runs on DIRECT execution (`tsx examples/refinance.ts`), never
 * merely on import — see the guard at the bottom of this file — and `main()`
 * itself validates `RPC_URL` (helpful error + non-zero exit when absent).
 * These are two independent checks on purpose: `RPC_URL`-presence ALONE is
 * not a safe import guard (a process that happens to have `RPC_URL` set —
 * e.g. this file imported from a live-fork test suite — would otherwise
 * fire a real run, `process.exit` included, as a side effect of importing
 * it), and direct-execution ALONE doesn't validate the env var either.
 *
 * What this demonstrates, end to end:
 *   1. `defineTask` + human-readable ABI (F3) + `t.derive` (F2) — Aave v3 and
 *      Spark (an Aave v3 fork sharing the same ABI) `getReserveData` bulk
 *      over three reserve assets each, extracting just the supply/borrow
 *      rate fields out of the full struct.
 *   2. The **dynamic-target showcase**: Morpho Blue's IRM borrow rate is a
 *      genuine 2-step task — step 1 reads `idToMarketParams`/`market` on
 *      Morpho Blue itself; step 2 calls `borrowRateView` ON THE IRM
 *      CONTRACT, whose address is only known once step 1 resolves. That
 *      address is threaded through as `target: Ref<Address | undefined>` —
 *      see `buildMorphoIrmRateTask` below.
 *   3. `Presets.throughput` (F7) — both the reserve bulk AND the Morpho task
 *      run through ONE `runMultistepTasks` call. Mixing a `maxStep: 1` task
 *      set with a `maxStep: 2` task in the same call is deliberate, not
 *      incidental — CLAUDE.md's "Mixed-depth batches" note applies exactly
 *      here: the reserve calls ride along in Morpho's own step-1 batch, so
 *      the whole comparison costs 2 round-trips total instead of 1 (reserves
 *      alone) + 2 (Morpho alone) = 3.
 *   4. `MultichainResolver` + `snapshot()` + explicit per-chain `blocks`
 *      pinning (F9/F8) — `refinanceMultichain()` below, gated by the P9 env
 *      convention (`RPC_URL` for mainnet, `RPC_URL_8453` for Base).
 *
 * Two on-chain values below are given as literals and are NOT independently
 * re-derived here — flagged inline with "verify at runtime" — because this
 * file's merge gate is the type-check, not a live assertion (spec G2):
 * the wstETH/WETH Morpho market id, and the Base Aave v3 Pool/USDC
 * addresses used only by the optional multichain variant.
 */

import { fileURLToPath } from 'node:url'
import { createPublicClient, http } from 'viem'
import { mainnet, base } from 'viem/chains'
import {
  Eip1193Executor,
  MultichainResolver,
  Presets,
  defineTask,
  runMultistepTasks,
} from '@halaprix/domino'
import type { Address, BlockParam, MultistepTask, StepExecutor } from '@halaprix/domino'

// ─── Protocol addresses (mainnet) ──────────────────────────────────────────

const AAVE_V3_POOL: Address = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2'
const SPARK_POOL: Address = '0xC13e21B648A5Ee794902342038FF3aDAB66BE987'
const MORPHO_BLUE: Address = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb'

const WETH: Address = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const USDC: Address = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const DAI: Address = '0x6B175474E89094C44Da98b954EedeAC495271d0F'

// wstETH/WETH market on Morpho Blue mainnet — verify at runtime before a live
// run (only the type-check is the merge gate here, per spec G2).
const WSTETH_WETH_MARKET_ID: `0x${string}` =
  '0xc54d7acf14de29e0e5527cabd7a576506870346a78a11a6762e2cca66322ec41'

// Base mainnet, used only by `refinanceMultichain()` — verify at runtime
// before a live run against Base (same caveat as the market id above).
const AAVE_V3_POOL_BASE: Address = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5'
const USDC_BASE: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

// ─── ABIs (human-readable, inlined — CLAUDE.md handler convention) ─────────

/**
 * Aave v3 Pool.getReserveData — Spark is a same-ABI Aave v3 fork, so this one
 * ABI is reused for both pools. `getReserveData` returns exactly ONE output,
 * whose type is a `tuple` with named `components` — Solidity keeps this as a
 * single nested struct (unlike `morphoBlueAbi` below), so it decodes to ONE
 * JS object keyed by field name. The tuple is declared faithfully in full
 * (all 15 fields, including the nested `ReserveConfigurationMap`) even
 * though only `currentLiquidityRate`/`currentVariableBorrowRate` are read —
 * a human-readable ABI's `returns` type must match the real struct shape for
 * decoding to succeed at all.
 */
const aaveV3PoolAbi = [
  'struct ReserveConfigurationMap { uint256 data; }',
  'struct ReserveData { ReserveConfigurationMap configuration; uint128 liquidityIndex; uint128 currentLiquidityRate; uint128 variableBorrowIndex; uint128 currentVariableBorrowRate; uint128 currentStableBorrowRate; uint40 lastUpdateTimestamp; uint16 id; address aTokenAddress; address stableDebtTokenAddress; address variableDebtTokenAddress; address interestRateStrategyAddress; uint128 accruedToTreasury; uint128 unbacked; uint128 isolationModeTotalDebt; }',
  'function getReserveData(address asset) view returns (ReserveData)',
] as const

/**
 * Morpho Blue's `idToMarketParams`/`market` are public-mapping getters over
 * value-only structs — Solidity FLATTENS those into several separate named
 * outputs (a well-known getter quirk), NOT a single nested tuple like
 * `aaveV3PoolAbi`'s `getReserveData` above. Each decodes to a positional
 * array/tuple at runtime (TS's output labels are for readability only), so
 * `buildMorphoIrmRateTask` below indexes into it by position.
 */
const morphoBlueAbi = [
  'function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)',
  'function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)',
] as const

/**
 * Morpho's IRM (e.g. AdaptiveCurveIrm) — unlike the Morpho Blue getters
 * above, this genuinely takes two struct-typed ARGUMENTS (declared here via
 * `struct MarketParams`/`struct Market`), passed as named objects. Called on
 * the IRM contract's OWN address — which is only known dynamically, from
 * `idToMarketParams`'s step-1 result (see `buildMorphoIrmRateTask`).
 */
const morphoIrmAbi = [
  'struct MarketParams { address loanToken; address collateralToken; address oracle; address irm; uint256 lltv; }',
  'struct Market { uint128 totalSupplyAssets; uint128 totalSupplyShares; uint128 totalBorrowAssets; uint128 totalBorrowShares; uint128 lastUpdate; uint128 fee; }',
  'function borrowRateView(MarketParams marketParams, Market market) view returns (uint256)',
] as const

// ─── Aave v3 / Spark — getReserveData bulk ─────────────────────────────────

export interface ReserveRate {
  protocol: 'Aave v3' | 'Spark'
  assetLabel: string
  asset: Address
  /** RAY-scaled (1e27) annualized supply rate, straight off the struct. */
  supplyRateRay: bigint | undefined
  /** RAY-scaled (1e27) annualized variable borrow rate. */
  variableBorrowRateRay: bigint | undefined
}

export interface ReserveQuery {
  protocol: ReserveRate['protocol']
  pool: Address
  assetLabel: string
  asset: Address
}

/**
 * One `defineTask` per (pool, asset) pair — extracts just the two rate
 * fields out of `getReserveData`'s full struct via `t.derive` (F1/F2/F3
 * composing together). `optional: true` so one bad reserve/pool never takes
 * down the whole bulk read — matching the built-in handlers' convention
 * (see `src/handlers/erc4626.ts`).
 */
export function buildReserveRateTask(query: ReserveQuery): MultistepTask<ReserveRate> {
  return defineTask((t) => {
    const reserve = t.call({
      target: query.pool,
      abi: aaveV3PoolAbi,
      functionName: 'getReserveData',
      args: [query.asset],
      optional: true,
    })

    return {
      protocol: query.protocol,
      assetLabel: query.assetLabel,
      asset: query.asset,
      supplyRateRay: t.derive([reserve], (data) => data?.currentLiquidityRate),
      variableBorrowRateRay: t.derive([reserve], (data) => data?.currentVariableBorrowRate),
    }
  })
}

// ─── Morpho Blue — 2-step IRM rate with a dynamic `Ref<Address>` target ───

export interface MorphoIrmRate {
  marketId: `0x${string}`
  /**
   * IRM contract address — resolved dynamically from `idToMarketParams` in
   * step 1, then used AS THE CALL TARGET for `borrowRateView` in step 2.
   * This is the spec's `Ref<Address>` dynamic-target showcase.
   */
  irm: Address | undefined
  /** WAD-scaled (1e18) per-second borrow rate from the IRM. */
  borrowRatePerSecondWad: bigint | undefined
}

export function buildMorphoIrmRateTask(marketId: `0x${string}`): MultistepTask<MorphoIrmRate> {
  return defineTask((t) => {
    // Step 1 (depth 1): both calls target Morpho Blue itself and are mutually
    // independent, so they land in the same step/batch.
    const paramsCall = t.call({
      target: MORPHO_BLUE,
      abi: morphoBlueAbi,
      functionName: 'idToMarketParams',
      args: [marketId],
      optional: true,
    })
    const marketCall = t.call({
      target: MORPHO_BLUE,
      abi: morphoBlueAbi,
      functionName: 'market',
      args: [marketId],
      optional: true,
    })

    // `idToMarketParams` decodes to a flat 5-tuple (see morphoBlueAbi's doc
    // comment) — position 3 is `irm`.
    const irm = t.derive([paramsCall], (p) => p?.[3])

    const marketParams = t.derive([paramsCall], (p) =>
      p === undefined
        ? undefined
        : { loanToken: p[0], collateralToken: p[1], oracle: p[2], irm: p[3], lltv: p[4] },
    )
    const marketState = t.derive([marketCall], (m) =>
      m === undefined
        ? undefined
        : {
            totalSupplyAssets: m[0],
            totalSupplyShares: m[1],
            totalBorrowAssets: m[2],
            totalBorrowShares: m[3],
            lastUpdate: m[4],
            fee: m[5],
          },
    )

    // Step 2 (depth 2): THE showcase — `target` is `irm`, a `Ref<Address |
    // undefined>` produced by step 1, not a literal address. If `irm` never
    // resolved, the runtime skip-chain rule (src/core/defineTask.ts) simply
    // skips this call rather than dispatching it with a bogus target.
    const borrowRate = t.call({
      target: irm,
      abi: morphoIrmAbi,
      functionName: 'borrowRateView',
      args: [marketParams, marketState],
      optional: true,
    })

    return {
      marketId,
      irm,
      borrowRatePerSecondWad: borrowRate,
    }
  })
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

export interface RefinanceComparison {
  reserves: ReserveRate[]
  morpho: MorphoIrmRate
}

const RESERVE_QUERIES: ReserveQuery[] = [
  { protocol: 'Aave v3', pool: AAVE_V3_POOL, assetLabel: 'WETH', asset: WETH },
  { protocol: 'Aave v3', pool: AAVE_V3_POOL, assetLabel: 'USDC', asset: USDC },
  { protocol: 'Aave v3', pool: AAVE_V3_POOL, assetLabel: 'DAI', asset: DAI },
  { protocol: 'Spark', pool: SPARK_POOL, assetLabel: 'WETH', asset: WETH },
  { protocol: 'Spark', pool: SPARK_POOL, assetLabel: 'USDC', asset: USDC },
  { protocol: 'Spark', pool: SPARK_POOL, assetLabel: 'DAI', asset: DAI },
]

/**
 * Runs the Aave v3 + Spark reserve-rate bulk AND the Morpho 2-step IRM rate
 * task TOGETHER, in one `runMultistepTasks` call gated by `Presets.throughput`
 * (F7 — concurrent batch dispatch + adaptive bisection + within-step dedup).
 *
 * The combined array is typed `MultistepTask<unknown>[]` (mirroring
 * `MultichainResolver`'s own single-`T`-generic note — mixed result shapes
 * need one call per shape, or type erasure here) and the two known slices are
 * cast back on the way out; see the module doc comment for why they're
 * combined into one call in the first place (round-trip savings from mixed-
 * depth batching, not just convenience).
 */
export async function refinance(executor: StepExecutor): Promise<RefinanceComparison> {
  const reserveTasks = RESERVE_QUERIES.map(buildReserveRateTask)
  const morphoTask = buildMorphoIrmRateTask(WSTETH_WETH_MARKET_ID)

  const tasks: MultistepTask<unknown>[] = [...reserveTasks, morphoTask]
  const results = await runMultistepTasks(executor, tasks, Presets.throughput)

  return {
    reserves: results.slice(0, reserveTasks.length) as ReserveRate[],
    morpho: results[results.length - 1] as MorphoIrmRate,
  }
}

// ─── Multichain variant — MultichainResolver + snapshot()/blocks pinning ──

export type MultichainRefinanceResult = Record<number, ReserveRate[]>

/**
 * Same Aave-v3-shaped reserve-rate read, fanned out across chains via
 * `MultichainResolver` — mainnet always, plus Base when `RPC_URL_8453` is
 * present (the P9 env convention: `RPC_URL` for mainnet, `RPC_URL_<chainId>`
 * for every other chain); runs single-chain when only `RPC_URL` is set.
 *
 * Uses `snapshot()` + an explicit per-chain `blocks` map RATHER THAN
 * `pinBlock: true`: `pinBlock` resolves and pins one block fresh every time
 * `runAll`/`runAllSettled` is called — fine for a single atomic call, but
 * cross-chain rate COMPARISON wants ONE block per chain, observed once, then
 * reused across however many calls make up the comparison (here: one
 * `runAll`, but the same snapshot could just as well back a retry or a
 * second pass without re-observing a possibly-different block per chain).
 * `snapshot()` hands that per-chain block map back explicitly so the caller
 * can hold onto and reuse it — `pinBlock` alone has no way to do that, since
 * its resolved block never leaves the single run it was resolved for.
 */
export async function refinanceMultichain(): Promise<MultichainRefinanceResult> {
  const rpcUrl = process.env['RPC_URL']
  if (!rpcUrl) {
    throw new Error('refinanceMultichain: RPC_URL environment variable is required')
  }

  const chains: Record<number, StepExecutor> = {
    [mainnet.id]: new Eip1193Executor(createPublicClient({ chain: mainnet, transport: http(rpcUrl) })),
  }

  const baseRpcUrl = process.env['RPC_URL_8453']
  if (baseRpcUrl) {
    chains[base.id] = new Eip1193Executor(createPublicClient({ chain: base, transport: http(baseRpcUrl) }))
  }

  const resolver = new MultichainResolver(chains)
  // One observed block per chain, reused below for every task in this run —
  // see the doc comment above for why this (not `pinBlock: true`) is the
  // right tool for a cross-chain comparison. `snapshot()` returns block
  // NUMBERS (`Record<number, bigint>`); `blocks` wants `BlockParam`s, so each
  // chain's number is wrapped as an explicit `{ blockNumber }`.
  const chainBlocks = await resolver.snapshot()
  const blocks: Record<number, BlockParam> = Object.fromEntries(
    Object.entries(chainBlocks).map(([chainId, blockNumber]) => [chainId, { blockNumber }]),
  )

  const plan: Record<number, MultistepTask<ReserveRate>[]> = {
    [mainnet.id]: [
      buildReserveRateTask({ protocol: 'Aave v3', pool: AAVE_V3_POOL, assetLabel: 'USDC', asset: USDC }),
      buildReserveRateTask({ protocol: 'Aave v3', pool: AAVE_V3_POOL, assetLabel: 'WETH', asset: WETH }),
    ],
  }
  if (baseRpcUrl) {
    plan[base.id] = [
      buildReserveRateTask({
        protocol: 'Aave v3',
        pool: AAVE_V3_POOL_BASE,
        assetLabel: 'USDC',
        asset: USDC_BASE,
      }),
    ]
  }

  return resolver.runAll(plan, { ...Presets.throughput, blocks })
}

// ─── Console formatting ─────────────────────────────────────────────────────

function rayToApr(rateRay: bigint | undefined): string {
  if (rateRay === undefined) return '—'
  return `${((Number(rateRay) / 1e27) * 100).toFixed(2)}%`
}

function wadPerSecondToAprEstimate(ratePerSecondWad: bigint | undefined): string {
  if (ratePerSecondWad === undefined) return '—'
  // Simple-interest per-second -> APR estimate (compounding ignored) purely
  // for the printed comparison table — not a precision-critical figure.
  const perSecond = Number(ratePerSecondWad) / 1e18
  const apr = perSecond * 365 * 24 * 60 * 60 * 100
  return `${apr.toFixed(2)}%`
}

function printRatesTable(label: string, reserves: ReserveRate[]): void {
  console.log(`\n  ${label}\n`)
  const colW = [10, 8, 14, 20]
  const headers = ['protocol', 'asset', 'supply APR', 'variable borrow APR']
  const sep = colW.map((w) => '─'.repeat(w)).join('┼')

  console.log('  ┌' + sep + '┐')
  console.log('  │' + headers.map((h, i) => h.padEnd(colW[i]!)).join('│') + '│')
  console.log('  ├' + sep + '┤')
  for (const r of reserves) {
    const cells = [
      r.protocol.padEnd(colW[0]!),
      r.assetLabel.padEnd(colW[1]!),
      rayToApr(r.supplyRateRay).padEnd(colW[2]!),
      rayToApr(r.variableBorrowRateRay).padEnd(colW[3]!),
    ]
    console.log('  │' + cells.join('│') + '│')
  }
  console.log('  └' + sep + '┘')
}

function printMorphoRate(morpho: MorphoIrmRate): void {
  console.log('\n  Morpho Blue — 2-step IRM rate (dynamic Ref<Address> target)\n')
  console.log(`    market:            ${morpho.marketId}`)
  console.log(`    irm (from step 1): ${morpho.irm ?? '—'}`)
  console.log(`    borrow APR (est):  ${wadPerSecondToAprEstimate(morpho.borrowRatePerSecondWad)}`)
}

// ─── main() — live run, gated by RPC_URL ───────────────────────────────────

async function main(): Promise<void> {
  const rpcUrl = process.env['RPC_URL']
  if (!rpcUrl) {
    console.error(
      '\nError: RPC_URL environment variable is required.\n\n' +
        '  RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY npx tsx examples/refinance.ts\n',
    )
    process.exit(1)
  }

  console.log('\n━━━  domino refinance example (G2)  ━━━')

  const provider = createPublicClient({ chain: mainnet, transport: http(rpcUrl) })
  const executor = new Eip1193Executor(provider)

  const { reserves, morpho } = await refinance(executor)
  printRatesTable('Aave v3 / Spark — getReserveData bulk (Presets.throughput)', reserves)
  printMorphoRate(morpho)

  if (process.env['RPC_URL_8453']) {
    console.log('\n  Multichain variant (mainnet + Base, snapshot() + blocks pinning)')
    const perChain = await refinanceMultichain()
    for (const [chainId, rates] of Object.entries(perChain)) {
      printRatesTable(`chain ${chainId}`, rates)
    }
  } else {
    console.log('\n  (Set RPC_URL_8453 to also run the multichain variant against Base.)')
  }

  console.log('\nDone.\n')
}

// external review, P2: `RPC_URL`-presence is NOT a safe import guard — a
// process that happens to have `RPC_URL` set (e.g. this module imported
// from a live-fork test suite, or any other consumer) would otherwise fire
// a real run — `process.exit` included — as a side effect of merely
// importing it. The real guard is DIRECT EXECUTION: `main()` only runs when
// this file is the process's actual entry point (`tsx examples/refinance.ts`
// / `node examples/refinance.js`), detected by comparing this module's own
// URL to `process.argv[1]` (the script Node/tsx was invoked with) via
// `fileURLToPath` — never merely on import, regardless of what's in the
// environment. `RPC_URL` itself is validated INSIDE `main()` (helpful error
// + non-zero exit when absent — mirrors scripts/benchmark-live.ts's guard
// style), independently of this direct-execution check.
const isDirectExecution =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]

if (isDirectExecution) {
  void main().catch((err: unknown) => {
    console.error('\nFatal error:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
