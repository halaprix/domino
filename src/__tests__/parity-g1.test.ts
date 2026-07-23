/**
 * G1 parity gate — new (`defineTask`-based) `buildErc20Task`/`buildErc4626Task`
 * vs. the pre-migration legacy oracle
 * (`src/__tests__/fixtures/legacy-handlers/{erc20,erc4626}.ts`).
 *
 * Every scenario below runs the IDENTICAL positional mock `RawResult[]`
 * sequence through both implementations (via the same `runMultistepTasks`
 * runner) and asserts `expect(fresh).toStrictEqual(legacy)` — bigints,
 * key presence (absent vs. `undefined`), and array order all distinguished.
 * See `src/handlers/erc4626.ts`'s module doc for why `position`'s
 * conditional-spread keys (T11) are the subtlest trap here.
 *
 * **Accepted deltas (documented, asserted explicitly below, NOT
 * parity-breaking):**
 *   1. Under `runSettled`, the new impl populates
 *      `diagnostics.optionalFailures` (legacy always reports `[]` — it
 *      carries no diagnostics channel at all). Resolved VALUES still match.
 *   2. New handler calls are dedup-ELIGIBLE (`TypedCallSpec`-compiled) —
 *      `{ dedupe: true }` can now merge identical calls across bulk entries;
 *      legacy hand-authored `StepCall`s are never eligible. This is a
 *      non-parity, opt-in behavior upgrade (default `dedupe` is `false`, so
 *      every `toStrictEqual` scenario above runs at defaults / dedup off).
 */

import { describe, it, expect, vi } from 'vitest'
import { runMultistepTasks } from '../core/runMultistepTasks'
import { runSettled } from '../core/runSettled'
import { DominoCallError } from '../core/errors'
import { buildErc20Task } from '../handlers/erc20'
import { buildErc4626Task } from '../handlers/erc4626'
import { buildErc20TaskLegacy } from './fixtures/legacy-handlers/erc20'
import { buildErc4626TaskLegacy } from './fixtures/legacy-handlers/erc4626'
import type { Address, MultistepTask, RawResult, StepExecutor } from '../core/types'

const TOKEN = '0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4' as Address
const TOKEN2 = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as Address
const TOKEN3 = '0x6B175474E89094C44Da98b954EedeAC495271d0F' as Address
const OWNER = '0x1234567890123456789012345678901234567890' as Address
const VAULT = '0x7f39c5812d3f46fCEa82257f5aE43fF59E7E9F8a' as Address
const ASSET = '0xae7ab96520de3a18e5e111b5eaab095312d7fe84' as Address

function mockExecutorFrom(steps: RawResult[][]): StepExecutor {
  const fn = vi.fn()
  for (const batch of steps) fn.mockResolvedValueOnce(batch)
  return { executeMulticall: fn }
}

/**
 * Runs `params` through both the legacy oracle and the new implementation,
 * each against its OWN mock executor pre-loaded with the SAME positional
 * `steps` sequence — so a call-creation-order mismatch between the two
 * builders would desync the mock and surface as a wrong value, not just a
 * shape mismatch.
 */
async function runBoth<P, R>(
  buildLegacy: (p: P) => MultistepTask<R>,
  buildNew: (p: P) => MultistepTask<R>,
  params: P,
  steps: RawResult[][],
): Promise<{ legacy: R; fresh: R; legacyExecutor: StepExecutor; freshExecutor: StepExecutor }> {
  const legacyExecutor = mockExecutorFrom(steps)
  const freshExecutor = mockExecutorFrom(steps)
  const [legacy] = await runMultistepTasks(legacyExecutor, [buildLegacy(params)])
  const [fresh] = await runMultistepTasks(freshExecutor, [buildNew(params)])
  return { legacy: legacy!, fresh: fresh!, legacyExecutor, freshExecutor }
}

describe('G1 parity — erc20', () => {
  it('without owner : symbol + decimals succeed', async () => {
    const { legacy, fresh } = await runBoth(
      buildErc20TaskLegacy,
      buildErc20Task,
      { token: TOKEN },
      [[
        { status: 'success', value: 'USDC' },
        { status: 'success', value: 6n }, // bigint on the wire — both impls coerce via asNumber
      ]],
    )
    expect(fresh).toStrictEqual(legacy)
    expect(fresh).toStrictEqual({ symbol: 'USDC', decimals: 6, balance: undefined })
  })

  it('with owner : symbol + decimals + balance succeed', async () => {
    const { legacy, fresh } = await runBoth(
      buildErc20TaskLegacy,
      buildErc20Task,
      { token: TOKEN, owner: OWNER },
      [[
        { status: 'success', value: 'USDC' },
        { status: 'success', value: 6n },
        { status: 'success', value: 1_000_000n },
      ]],
    )
    expect(fresh).toStrictEqual(legacy)
    expect(fresh).toStrictEqual({ symbol: 'USDC', decimals: 6, balance: 1_000_000n })
  })

  it('symbol call fails individually : demotes to undefined, siblings unaffected', async () => {
    const { legacy, fresh } = await runBoth(
      buildErc20TaskLegacy,
      buildErc20Task,
      { token: TOKEN, owner: OWNER },
      [[
        { status: 'failure' },
        { status: 'success', value: 6n },
        { status: 'success', value: 1_000_000n },
      ]],
    )
    expect(fresh).toStrictEqual(legacy)
    expect(fresh).toStrictEqual({ symbol: undefined, decimals: 6, balance: 1_000_000n })
  })

  it('decimals call fails individually : demotes to undefined, siblings unaffected', async () => {
    const { legacy, fresh } = await runBoth(
      buildErc20TaskLegacy,
      buildErc20Task,
      { token: TOKEN, owner: OWNER },
      [[
        { status: 'success', value: 'USDC' },
        { status: 'failure' },
        { status: 'success', value: 1_000_000n },
      ]],
    )
    expect(fresh).toStrictEqual(legacy)
    expect(fresh).toStrictEqual({ symbol: 'USDC', decimals: undefined, balance: 1_000_000n })
  })

  it('balance call fails individually : demotes to undefined, siblings unaffected', async () => {
    const { legacy, fresh } = await runBoth(
      buildErc20TaskLegacy,
      buildErc20Task,
      { token: TOKEN, owner: OWNER },
      [[
        { status: 'success', value: 'USDC' },
        { status: 'success', value: 6n },
        { status: 'failure' },
      ]],
    )
    expect(fresh).toStrictEqual(legacy)
    expect(fresh).toStrictEqual({ symbol: 'USDC', decimals: 6, balance: undefined })
  })

  it('all calls fail : every field undefined', async () => {
    const { legacy, fresh } = await runBoth(
      buildErc20TaskLegacy,
      buildErc20Task,
      { token: TOKEN, owner: OWNER },
      [[
        { status: 'failure' },
        { status: 'failure' },
        { status: 'failure' },
      ]],
    )
    expect(fresh).toStrictEqual(legacy)
    expect(fresh).toStrictEqual({ symbol: undefined, decimals: undefined, balance: undefined })
  })

  it('bulk (3 entries, batchSize 2) : slicing parity across 5 physical batches', async () => {
    // 3 entries x 3 calls (symbol, decimals, balanceOf) = 9 calls -> batches of 2,2,2,2,1
    const entries = [
      { token: TOKEN, owner: OWNER },
      { token: TOKEN2, owner: OWNER },
      { token: TOKEN3, owner: OWNER },
    ]
    const flat: RawResult[] = [
      { status: 'success', value: 'AAA' },
      { status: 'success', value: 6n },
      { status: 'success', value: 1n },
      { status: 'success', value: 'BBB' },
      { status: 'success', value: 18n },
      { status: 'success', value: 2n },
      { status: 'success', value: 'CCC' },
      { status: 'success', value: 8n },
      { status: 'success', value: 3n },
    ]
    const batchSize = 2
    const batches: RawResult[][] = []
    for (let i = 0; i < flat.length; i += batchSize) batches.push(flat.slice(i, i + batchSize))

    const legacyExecutor = mockExecutorFrom(batches)
    const freshExecutor = mockExecutorFrom(batches)

    const legacyResults = await runMultistepTasks(
      legacyExecutor,
      entries.map((e) => buildErc20TaskLegacy(e)),
      { batchSize },
    )
    const freshResults = await runMultistepTasks(
      freshExecutor,
      entries.map((e) => buildErc20Task(e)),
      { batchSize },
    )

    expect(freshResults).toStrictEqual(legacyResults)
    expect(freshResults).toStrictEqual([
      { symbol: 'AAA', decimals: 6, balance: 1n },
      { symbol: 'BBB', decimals: 18, balance: 2n },
      { symbol: 'CCC', decimals: 8, balance: 3n },
    ])
    expect((legacyExecutor.executeMulticall as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(5)
    expect((freshExecutor.executeMulticall as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(5)
  })
})

describe('G1 parity — erc4626', () => {
  it('without owner : symbol + decimals + asset succeed, single step', async () => {
    const { legacy, fresh, legacyExecutor, freshExecutor } = await runBoth(
      buildErc4626TaskLegacy,
      buildErc4626Task,
      { vault: VAULT },
      [[
        { status: 'success', value: 'wstETH' },
        { status: 'success', value: 18n },
        { status: 'success', value: ASSET },
      ]],
    )
    expect(fresh).toStrictEqual(legacy)
    expect(fresh).toStrictEqual({
      metadata: { symbol: 'wstETH', decimals: 18, underlyingAsset: ASSET, maxWithdraw: undefined, maxRedeem: undefined },
      position: undefined,
    })
    expect(legacyExecutor.executeMulticall).toHaveBeenCalledTimes(1)
    expect(freshExecutor.executeMulticall).toHaveBeenCalledTimes(1)
  })

  it('with owner : full 2-step resolution, all succeed', async () => {
    const { legacy, fresh, legacyExecutor, freshExecutor } = await runBoth(
      buildErc4626TaskLegacy,
      buildErc4626Task,
      { vault: VAULT, owner: OWNER },
      [
        [
          { status: 'success', value: 'wstETH' },
          { status: 'success', value: 18n },
          { status: 'success', value: ASSET },
          { status: 'success', value: 500_000_000_000_000_000n },
          { status: 'success', value: 1_000_000_000_000_000_000n },
          { status: 'success', value: 900_000_000_000_000_000n },
        ],
        [{ status: 'success', value: 501_234_567_890_123_456n }],
      ],
    )
    expect(fresh).toStrictEqual(legacy)
    expect(fresh).toStrictEqual({
      metadata: {
        symbol: 'wstETH',
        decimals: 18,
        underlyingAsset: ASSET,
        maxWithdraw: 1_000_000_000_000_000_000n,
        maxRedeem: 900_000_000_000_000_000n,
      },
      position: {
        balance: 500_000_000_000_000_000n,
        assets: 501_234_567_890_123_456n,
        maxWithdraw: 1_000_000_000_000_000_000n,
        maxRedeem: 900_000_000_000_000_000n,
      },
    })
    expect(legacyExecutor.executeMulticall).toHaveBeenCalledTimes(2)
    expect(freshExecutor.executeMulticall).toHaveBeenCalledTimes(2)
  })

  const step1Fields: { name: string; index: number; expectSuccess: Omit<RawResult, 'status'> }[] = [
    { name: 'symbol', index: 0, expectSuccess: { value: 'wstETH' } },
    { name: 'decimals', index: 1, expectSuccess: { value: 18n } },
    { name: 'asset', index: 2, expectSuccess: { value: ASSET } },
    { name: 'balanceOf', index: 3, expectSuccess: { value: 500_000_000_000_000_000n } },
    { name: 'maxWithdraw', index: 4, expectSuccess: { value: 1_000_000_000_000_000_000n } },
    { name: 'maxRedeem', index: 5, expectSuccess: { value: 900_000_000_000_000_000n } },
  ]

  for (const field of step1Fields) {
    it(`${field.name} call fails individually (with owner) : demotes to undefined${field.name === 'balanceOf' ? ', step 2 skipped' : ''}`, async () => {
      const base: RawResult[] = [
        { status: 'success', value: 'wstETH' },
        { status: 'success', value: 18n },
        { status: 'success', value: ASSET },
        { status: 'success', value: 500_000_000_000_000_000n },
        { status: 'success', value: 1_000_000_000_000_000_000n },
        { status: 'success', value: 900_000_000_000_000_000n },
      ]
      const step1 = base.map((r, i): RawResult => (i === field.index ? { status: 'failure' } : r))
      // Step 2 (convertToAssets) is only ever dispatched if balanceOf succeeded.
      const steps: RawResult[][] = field.name === 'balanceOf'
        ? [step1]
        : [step1, [{ status: 'success', value: 501_234_567_890_123_456n }]]

      const { legacy, fresh, legacyExecutor, freshExecutor } = await runBoth(
        buildErc4626TaskLegacy,
        buildErc4626Task,
        { vault: VAULT, owner: OWNER },
        steps,
      )

      expect(fresh).toStrictEqual(legacy)
      if (field.name === 'balanceOf') {
        expect(legacyExecutor.executeMulticall).toHaveBeenCalledTimes(1)
        expect(freshExecutor.executeMulticall).toHaveBeenCalledTimes(1)
        expect(fresh.position).toBeUndefined()
      } else {
        expect(legacyExecutor.executeMulticall).toHaveBeenCalledTimes(2)
        expect(freshExecutor.executeMulticall).toHaveBeenCalledTimes(2)
      }
    })
  }

  it('convertToAssets (step 2) fails : assets undefined, balance/maxWithdraw/maxRedeem unaffected', async () => {
    const { legacy, fresh } = await runBoth(
      buildErc4626TaskLegacy,
      buildErc4626Task,
      { vault: VAULT, owner: OWNER },
      [
        [
          { status: 'success', value: 'wstETH' },
          { status: 'success', value: 18n },
          { status: 'success', value: ASSET },
          { status: 'success', value: 500_000_000_000_000_000n },
          { status: 'success', value: 1_000_000_000_000_000_000n },
          { status: 'success', value: 900_000_000_000_000_000n },
        ],
        [{ status: 'failure' }],
      ],
    )
    expect(fresh).toStrictEqual(legacy)
    expect(fresh.position).toStrictEqual({
      balance: 500_000_000_000_000_000n,
      assets: undefined,
      maxWithdraw: 1_000_000_000_000_000_000n,
      maxRedeem: 900_000_000_000_000_000n,
    })
  })

  it('all step-1 calls fail (with owner) : metadata all undefined, position undefined, no step 2', async () => {
    const { legacy, fresh, legacyExecutor, freshExecutor } = await runBoth(
      buildErc4626TaskLegacy,
      buildErc4626Task,
      { vault: VAULT, owner: OWNER },
      [[
        { status: 'failure' },
        { status: 'failure' },
        { status: 'failure' },
        { status: 'failure' },
        { status: 'failure' },
        { status: 'failure' },
      ]],
    )
    expect(fresh).toStrictEqual(legacy)
    expect(fresh).toStrictEqual({
      metadata: {
        symbol: undefined,
        decimals: undefined,
        underlyingAsset: undefined,
        maxWithdraw: undefined,
        maxRedeem: undefined,
      },
      position: undefined,
    })
    expect(legacyExecutor.executeMulticall).toHaveBeenCalledTimes(1)
    expect(freshExecutor.executeMulticall).toHaveBeenCalledTimes(1)
  })

  it('bulk (3 entries, batchSize 2) : slicing parity across steps 1 and 2', async () => {
    const vault2 = '0x21dD1dB4FE11338FDE9Bf81DDCd046e228B436F5' as Address
    const vault3 = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419' as Address
    const entries = [
      { vault: VAULT, owner: OWNER },
      { vault: vault2, owner: OWNER },
      { vault: vault3, owner: OWNER },
    ]

    // Step 1: 6 calls x 3 entries = 18 -> batchSize 2 -> 9 batches
    const step1Flat: RawResult[] = [
      { status: 'success', value: 'AAA' },
      { status: 'success', value: 18n },
      { status: 'success', value: ASSET },
      { status: 'success', value: 1n },
      { status: 'success', value: 10n },
      { status: 'success', value: 11n },
      { status: 'success', value: 'BBB' },
      { status: 'success', value: 8n },
      { status: 'success', value: ASSET },
      { status: 'success', value: 2n },
      { status: 'success', value: 20n },
      { status: 'success', value: 21n },
      { status: 'success', value: 'CCC' },
      { status: 'success', value: 6n },
      { status: 'success', value: ASSET },
      { status: 'success', value: 3n },
      { status: 'success', value: 30n },
      { status: 'success', value: 31n },
    ]
    // Step 2: 1 call x 3 entries = 3 -> batchSize 2 -> 2 batches
    const step2Flat: RawResult[] = [
      { status: 'success', value: 100n },
      { status: 'success', value: 200n },
      { status: 'success', value: 300n },
    ]

    const batchSize = 2
    const batchesOf = (flat: RawResult[]): RawResult[][] => {
      const out: RawResult[][] = []
      for (let i = 0; i < flat.length; i += batchSize) out.push(flat.slice(i, i + batchSize))
      return out
    }
    const steps = [...batchesOf(step1Flat), ...batchesOf(step2Flat)]

    const legacyExecutor = mockExecutorFrom(steps)
    const freshExecutor = mockExecutorFrom(steps)

    const legacyResults = await runMultistepTasks(
      legacyExecutor,
      entries.map((e) => buildErc4626TaskLegacy(e)),
      { batchSize },
    )
    const freshResults = await runMultistepTasks(
      freshExecutor,
      entries.map((e) => buildErc4626Task(e)),
      { batchSize },
    )

    expect(freshResults).toStrictEqual(legacyResults)
    expect(freshResults[0]?.position).toStrictEqual({
      balance: 1n,
      assets: 100n,
      maxWithdraw: 10n,
      maxRedeem: 11n,
    })
    expect(freshResults[2]?.position).toStrictEqual({
      balance: 3n,
      assets: 300n,
      maxWithdraw: 30n,
      maxRedeem: 31n,
    })
  })
})

describe('G1 accepted delta 1 — runSettled diagnostics', () => {
  it('new impl retains the executor-produced DominoCallError in diagnostics.optionalFailures; legacy always reports []', async () => {
    const revertError = new DominoCallError('execution reverted', {
      kind: 'revert',
      data: '0x08c379a0',
      target: TOKEN,
      functionName: 'symbol',
    })

    const steps: RawResult[][] = [[
      { status: 'failure', error: revertError },
      { status: 'success', value: 6n },
      { status: 'success', value: 1_000_000n },
    ]]

    const legacyExecutor = mockExecutorFrom(steps)
    const freshExecutor = mockExecutorFrom(steps)

    const [legacySettled] = await runSettled(legacyExecutor, [
      buildErc20TaskLegacy({ token: TOKEN, owner: OWNER }),
    ])
    const [freshSettled] = await runSettled(freshExecutor, [
      buildErc20Task({ token: TOKEN, owner: OWNER }),
    ])

    // VALUES still match legacy — the delta is diagnostics-only.
    expect(legacySettled!.status).toBe('fulfilled')
    expect(freshSettled!.status).toBe('fulfilled')
    const legacyValue = (legacySettled as { status: 'fulfilled'; value: unknown }).value
    const freshValue = (freshSettled as { status: 'fulfilled'; value: unknown }).value
    expect(freshValue).toStrictEqual(legacyValue)
    expect(freshValue).toStrictEqual({ symbol: undefined, decimals: 6, balance: 1_000_000n })

    // Documented accepted delta: legacy carries no diagnostics channel at all.
    expect(legacySettled!.diagnostics).toStrictEqual({ optionalFailures: [] })

    // New impl: the executor-produced error passes through with kind/data
    // toBe-identical and the cause chain preserved (failure-fixture clause).
    expect(freshSettled!.diagnostics.optionalFailures).toHaveLength(1)
    const entry = freshSettled!.diagnostics.optionalFailures[0]!
    expect(entry.error).toBe(revertError)
    expect(entry.error.kind).toBe(revertError.kind)
    expect(entry.error.data).toBe(revertError.data)
    expect(entry.error.cause).toBe(revertError.cause)
    expect(entry.target).toBe(TOKEN)
    expect(entry.functionName).toBe('symbol')
  })
})

describe('G1 accepted delta 2 — dedup eligibility (behavior upgrade, non-parity)', () => {
  it('bulk + dedupe:true merges identical metadata calls across entries sharing the same token/owner', async () => {
    const invocations: unknown[][] = []
    const executor: StepExecutor = {
      async executeMulticall(calls) {
        invocations.push(calls)
        return calls.map((c): RawResult => {
          if (c.functionName === 'symbol') return { status: 'success', value: 'USDC' }
          if (c.functionName === 'decimals') return { status: 'success', value: 6n }
          return { status: 'success', value: 42n } // balanceOf
        })
      },
    }

    const entries = [
      { token: TOKEN, owner: OWNER },
      { token: TOKEN, owner: OWNER }, // identical target+owner -> merges under dedupe
    ]

    const results = await runMultistepTasks(
      executor,
      entries.map((e) => buildErc20Task(e)),
      { dedupe: true },
    )

    // Without dedupe this would be 6 calls (3 per entry); with dedupe, the 3
    // distinct (target, calldata, outputSignature) keys merge to 3 physical
    // calls, fanned out to both subscribers.
    expect(invocations).toHaveLength(1)
    expect(invocations[0]).toHaveLength(3)
    expect(results).toStrictEqual([
      { symbol: 'USDC', decimals: 6, balance: 42n },
      { symbol: 'USDC', decimals: 6, balance: 42n },
    ])
  })
})
