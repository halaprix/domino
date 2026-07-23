import { describe, it, expect } from 'vitest'
import { defineTask } from '../core/defineTask'
import { runMultistepTasks } from '../core/runMultistepTasks'
import { Presets } from '../core/presets'
import type { Address, MultistepTask, StepCall, StepExecutor, RawResult } from '../core/types'

/**
 * G2 smoke test — exercises the SAME task-construction pattern used by
 * `examples/refinance.ts` (an Aave-v3-shaped `getReserveData` struct
 * extraction, and Morpho's dynamic `Ref<Address>` IRM target) against a mock
 * `StepExecutor`, mirroring how `src/__tests__/erc4626.test.ts` and
 * `src/__tests__/multichain.test.ts` mock the executor for the built-in
 * handlers/resolver.
 *
 * **Why this duplicates, rather than imports, `examples/refinance.ts`'s ABIs
 * and builder logic (brief-authorized fallback, reported as required):**
 * the brief's preferred approach —
 * `import { buildReserveRateTask, buildMorphoIrmRateTask } from
 * '../../examples/refinance'` — was tried first and fails `npm run
 * typecheck` (root `tsconfig.json`: `rootDir: "src"`, `include: ["src"]`,
 * `declaration: true`, `outDir: "dist"`) with TS6059 ("File is not under
 * 'rootDir'"): `examples/refinance.ts` sits outside `src/`, and the moment
 * anything under `src/__tests__` references it, tsc pulls it into the same
 * program and has to compute an output path for it under `rootDir` — which
 * fails, since it isn't under `src/` at all.
 *
 * The brief's fallback — "only import types" via `import type { ... } from
 * '../../examples/refinance'` — was tried next and hits the IDENTICAL
 * TS6059. A type-only import still requires tsc to load and check the
 * source module to extract its type declarations (type-only imports are
 * elided at EMIT time, not at module-resolution/program-membership time),
 * so the file is still added to the program and still needs an output path
 * under `rootDir`. Neither of the brief's two options survives `npm run
 * typecheck` (verified directly: both were tried against a throwaway probe
 * file and both reproduced TS6059 before this file was written).
 *
 * This file therefore imports NOTHING from `examples/refinance.ts` — not
 * even types — and re-declares the minimal ABI/task shapes inline instead,
 * built from the SAME core primitives (`defineTask`, `runMultistepTasks`,
 * `Presets`) the real example uses. `examples/refinance.ts` itself is still
 * fully exercised by its own dedicated gate: `npm run check:snippets`
 * type-checks it against the BUILT dist types exactly like `docs/snippets/*`
 * (see `scripts/check-snippets.ts`, extended for G2 to also discover
 * `examples/*.ts`) — that is the merge gate for the example file itself;
 * this test's job is only to smoke-test that the PATTERN it demonstrates
 * (struct-field derive, dynamic `Ref<Address>` target, mixed-depth batching
 * under `Presets.throughput`) actually behaves as described at runtime.
 */

const POOL: Address = '0x1111111111111111111111111111111111111111'
const ASSET: Address = '0x2222222222222222222222222222222222222222'
const MORPHO: Address = '0x3333333333333333333333333333333333333333'
const IRM: Address = '0x4444444444444444444444444444444444444444'
const MARKET_ID = `0x${'5'.repeat(64)}` as const

// Mirrors examples/refinance.ts's `aaveV3PoolAbi` — a single struct-typed
// output, declared faithfully (all 15 fields) even though only two are read.
const aaveV3PoolAbi = [
  'struct ReserveConfigurationMap { uint256 data; }',
  'struct ReserveData { ReserveConfigurationMap configuration; uint128 liquidityIndex; uint128 currentLiquidityRate; uint128 variableBorrowIndex; uint128 currentVariableBorrowRate; uint128 currentStableBorrowRate; uint40 lastUpdateTimestamp; uint16 id; address aTokenAddress; address stableDebtTokenAddress; address variableDebtTokenAddress; address interestRateStrategyAddress; uint128 accruedToTreasury; uint128 unbacked; uint128 isolationModeTotalDebt; }',
  'function getReserveData(address asset) view returns (ReserveData)',
] as const

// Mirrors examples/refinance.ts's `morphoBlueAbi` — flat multi-output
// getters, NOT a single nested struct (see that file's doc comment).
const morphoBlueAbi = [
  'function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)',
  'function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)',
] as const

// Mirrors examples/refinance.ts's `morphoIrmAbi`.
const morphoIrmAbi = [
  'struct MarketParams { address loanToken; address collateralToken; address oracle; address irm; uint256 lltv; }',
  'struct Market { uint128 totalSupplyAssets; uint128 totalSupplyShares; uint128 totalBorrowAssets; uint128 totalBorrowShares; uint128 lastUpdate; uint128 fee; }',
  'function borrowRateView(MarketParams marketParams, Market market) view returns (uint256)',
] as const

interface ReserveRate {
  supplyRateRay: bigint | undefined
  variableBorrowRateRay: bigint | undefined
}

/** Mirrors examples/refinance.ts's `buildReserveRateTask`. */
function buildReserveRateTask(pool: Address, asset: Address): MultistepTask<ReserveRate> {
  return defineTask((t) => {
    const reserve = t.call({
      target: pool,
      abi: aaveV3PoolAbi,
      functionName: 'getReserveData',
      args: [asset],
      optional: true,
    })
    return {
      supplyRateRay: t.derive([reserve], (data) => data?.currentLiquidityRate),
      variableBorrowRateRay: t.derive([reserve], (data) => data?.currentVariableBorrowRate),
    }
  })
}

interface MorphoIrmRate {
  irm: Address | undefined
  borrowRatePerSecondWad: bigint | undefined
}

/** Mirrors examples/refinance.ts's `buildMorphoIrmRateTask` — the dynamic
 *  `Ref<Address>` target showcase: step 2's `target` is `irm`, resolved from
 *  step 1's `idToMarketParams` result. */
function buildMorphoIrmRateTask(marketId: `0x${string}`): MultistepTask<MorphoIrmRate> {
  return defineTask((t) => {
    const paramsCall = t.call({
      target: MORPHO,
      abi: morphoBlueAbi,
      functionName: 'idToMarketParams',
      args: [marketId],
      optional: true,
    })
    const marketCall = t.call({
      target: MORPHO,
      abi: morphoBlueAbi,
      functionName: 'market',
      args: [marketId],
      optional: true,
    })

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

    const borrowRate = t.call({
      target: irm,
      abi: morphoIrmAbi,
      functionName: 'borrowRateView',
      args: [marketParams, marketState],
      optional: true,
    })

    return { irm, borrowRatePerSecondWad: borrowRate }
  })
}

// ─── Mock executor ──────────────────────────────────────────────────────────

interface TrackingExecutor extends StepExecutor {
  invocations: StepCall[][]
}

function makeExecutor(): TrackingExecutor {
  const invocations: StepCall[][] = []
  return {
    invocations,
    async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
      invocations.push(calls)
      return calls.map((c): RawResult => {
        if (c.functionName === 'getReserveData') {
          return {
            status: 'success',
            value: {
              configuration: { data: 0n },
              liquidityIndex: 0n,
              currentLiquidityRate: 12_345n,
              variableBorrowIndex: 0n,
              currentVariableBorrowRate: 67_890n,
              currentStableBorrowRate: 0n,
              lastUpdateTimestamp: 0,
              id: 0,
              aTokenAddress: ASSET,
              stableDebtTokenAddress: ASSET,
              variableDebtTokenAddress: ASSET,
              interestRateStrategyAddress: ASSET,
              accruedToTreasury: 0n,
              unbacked: 0n,
              isolationModeTotalDebt: 0n,
            },
          }
        }
        if (c.functionName === 'idToMarketParams') {
          return { status: 'success', value: [ASSET, ASSET, ASSET, IRM, 900_000_000_000_000_000n] }
        }
        if (c.functionName === 'market') {
          return { status: 'success', value: [1000n, 1000n, 500n, 500n, 123n, 0n] }
        }
        if (c.functionName === 'borrowRateView') {
          return { status: 'success', value: 31_709_791n }
        }
        return { status: 'failure' }
      })
    },
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('G2 refinance example — task construction (dry, mocked executor)', () => {
  it('buildReserveRateTask: extracts the two rate fields out of the full getReserveData struct', async () => {
    const executor = makeExecutor()
    const [result] = await runMultistepTasks(executor, [buildReserveRateTask(POOL, ASSET)])

    expect(result?.supplyRateRay).toBe(12_345n)
    expect(result?.variableBorrowRateRay).toBe(67_890n)
    expect(executor.invocations).toHaveLength(1)
  })

  it('buildMorphoIrmRateTask: step 2 dispatches to the IRM address resolved dynamically in step 1 (Ref<Address> target)', async () => {
    const executor = makeExecutor()
    const [result] = await runMultistepTasks(executor, [buildMorphoIrmRateTask(MARKET_ID)])

    // Two steps: step 1 (idToMarketParams + market), step 2 (borrowRateView).
    expect(executor.invocations).toHaveLength(2)
    expect(executor.invocations[0]).toHaveLength(2)
    expect(executor.invocations[1]).toHaveLength(1)

    // The showcase: borrowRateView's target is the DYNAMIC irm address from
    // step 1 — never the literal Morpho Blue address.
    const step2Call = executor.invocations[1]?.[0]
    expect(step2Call?.target).toBe(IRM)
    expect(step2Call?.target).not.toBe(MORPHO)

    expect(result?.irm).toBe(IRM)
    expect(result?.borrowRatePerSecondWad).toBe(31_709_791n)
  })

  it('mixed-depth batching under Presets.throughput: a maxStep-1 reserve task rides along in the maxStep-2 Morpho task\'s own step-1 batch', async () => {
    const executor = makeExecutor()
    const reserveTask = buildReserveRateTask(POOL, ASSET)
    const morphoTask = buildMorphoIrmRateTask(MARKET_ID)

    const tasks: MultistepTask<unknown>[] = [reserveTask, morphoTask]
    const results = await runMultistepTasks(executor, tasks, Presets.throughput)

    // Exactly 2 round-trips total (not 1 + 2 = 3): the reserve task's single
    // call is folded into Morpho's own step-1 batch. This is the concrete
    // behavior CLAUDE.md's "Mixed-depth batches" note describes.
    expect(executor.invocations).toHaveLength(2)
    expect(executor.invocations[0]).toHaveLength(3) // getReserveData + idToMarketParams + market
    expect(executor.invocations[1]).toHaveLength(1) // borrowRateView

    const reserveResult = results[0] as ReserveRate
    const morphoResult = results[1] as MorphoIrmRate
    expect(reserveResult.supplyRateRay).toBe(12_345n)
    expect(morphoResult.irm).toBe(IRM)
    expect(morphoResult.borrowRatePerSecondWad).toBe(31_709_791n)
  })
})
