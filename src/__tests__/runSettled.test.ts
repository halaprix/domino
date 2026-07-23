import { describe, it, expect } from 'vitest'
import { runSettled } from '../core/runSettled'
import { DominoCallError } from '../core/errors'
import type { MultistepTask, StepCall, StepResult, StepExecutor, RawResult } from '../core/types'

const ADDR = '0xA0b86991c6218b36c1d19D4a2e9Eb004C35d5Cc4' as const

describe('runSettled', () => {
  it('all-success: every entry is fulfilled with distinct diagnostics objects', async () => {
    const mockExecutor: StepExecutor = {
      async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
        return calls.map((c) => ({ status: 'success' as const, value: 'v-' + c.key }))
      },
    }

    const makeTask = (key: string): MultistepTask<{ v: string }> => {
      let captured: string | undefined
      return {
        maxStep: 1,
        buildStepCalls(step) {
          if (step !== 1) return []
          return [{ key, target: ADDR, abi: [], functionName: 'symbol' }]
        },
        consumeStepResults(_step, results) {
          const r = results.find((r) => r.key === key && r.status === 'success')
          captured = r?.status === 'success' ? (r.value as string) : undefined
        },
        finalize() {
          return { v: captured! }
        },
      }
    }

    const results = await runSettled(mockExecutor, [makeTask('a'), makeTask('b')])

    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({
      status: 'fulfilled',
      value: { v: 'v-a' },
      diagnostics: { optionalFailures: [] },
    })
    expect(results[1]).toEqual({
      status: 'fulfilled',
      value: { v: 'v-b' },
      diagnostics: { optionalFailures: [] },
    })
    // Diagnostics objects must be distinct instances per task, never shared.
    expect(results[0]!.diagnostics).not.toBe(results[1]!.diagnostics)
  })

  it('finalize throws for task A only -> A rejected with exact thrown object, B fulfilled', async () => {
    const mockExecutor: StepExecutor = {
      async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
        return calls.map(() => ({ status: 'success' as const, value: 'ok' }))
      },
    }

    const boom = new Error('finalize boom')

    const taskA: MultistepTask<never> = {
      maxStep: 1,
      buildStepCalls(step) {
        if (step !== 1) return []
        return [{ key: 'a', target: ADDR, abi: [], functionName: 'symbol' }]
      },
      consumeStepResults() {},
      finalize(): never {
        throw boom
      },
    }

    const taskB: MultistepTask<{ v: string }> = {
      maxStep: 1,
      buildStepCalls(step) {
        if (step !== 1) return []
        return [{ key: 'b', target: ADDR, abi: [], functionName: 'symbol' }]
      },
      consumeStepResults() {},
      finalize() {
        return { v: 'fine' }
      },
    }

    const [resultA, resultB] = await runSettled(mockExecutor, [taskA, taskB])

    expect(resultA).toEqual({
      status: 'rejected',
      error: boom,
      diagnostics: { optionalFailures: [] },
    })
    expect((resultA as { status: 'rejected'; error: unknown }).error).toBe(boom)
    expect(resultB).toEqual({
      status: 'fulfilled',
      value: { v: 'fine' },
      diagnostics: { optionalFailures: [] },
    })
  })

  it('executor rejects for step-1 batch: both sharing tasks get per-call kind:"batch" errors with identical cause; execution continues to step 2', async () => {
    const boom = new Error('RPC timeout')

    let step2Built = false

    const mockExecutor: StepExecutor = {
      async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
        if (calls.some((c) => c.key === 'a1')) {
          throw boom
        }
        // Step 2 batch succeeds.
        return calls.map(() => ({ status: 'success' as const, value: 42 }))
      },
    }

    let taskAStep1Results: StepResult[] = []
    let taskBStep1Results: StepResult[] = []
    let taskAStep2Results: StepResult[] = []

    const taskA: MultistepTask<{ step1: StepResult[]; step2: StepResult[] }> = {
      maxStep: 2,
      buildStepCalls(step) {
        if (step === 1) return [{ key: 'a1', target: ADDR, abi: [], functionName: 'foo' }]
        if (step === 2) {
          step2Built = true
          return [{ key: 'a2', target: ADDR, abi: [], functionName: 'bar' }]
        }
        return []
      },
      consumeStepResults(step, results) {
        if (step === 1) taskAStep1Results = results
        if (step === 2) taskAStep2Results = results
      },
      finalize() {
        return { step1: taskAStep1Results, step2: taskAStep2Results }
      },
    }

    const taskB: MultistepTask<{ step1: StepResult[] }> = {
      maxStep: 1,
      buildStepCalls(step) {
        if (step !== 1) return []
        return [{ key: 'b1', target: ADDR, abi: [], functionName: 'baz' }]
      },
      consumeStepResults(step, results) {
        if (step === 1) taskBStep1Results = results
      },
      finalize() {
        return { step1: taskBStep1Results }
      },
    }

    const [resultA, resultB] = await runSettled(mockExecutor, [taskA, taskB])

    // Continuation proof: step 2's buildStepCalls was invoked and its batch executed.
    expect(step2Built).toBe(true)

    // Both tasks fulfilled — batch failure alone does not reject a legacy task.
    expect(resultA!.status).toBe('fulfilled')
    expect(resultB!.status).toBe('fulfilled')

    // Task A's step-1 result: one failure, kind 'batch', cause identity preserved.
    expect(taskAStep1Results).toHaveLength(1)
    const errA = (taskAStep1Results[0] as { status: 'failure'; error?: unknown }).error
    expect(errA).toBeInstanceOf(DominoCallError)
    expect((errA as DominoCallError).kind).toBe('batch')
    expect((errA as DominoCallError).cause).toBe(boom)
    expect((errA as DominoCallError).target).toBe(ADDR)
    expect((errA as DominoCallError).functionName).toBe('foo')
    expect((errA as DominoCallError).key).toBe('a1')

    // Task B's step-1 result: same treatment, per-call instance (not shared with A's).
    expect(taskBStep1Results).toHaveLength(1)
    const errB = (taskBStep1Results[0] as { status: 'failure'; error?: unknown }).error
    expect(errB).toBeInstanceOf(DominoCallError)
    expect((errB as DominoCallError).kind).toBe('batch')
    expect((errB as DominoCallError).cause).toBe(boom)
    expect((errB as DominoCallError).key).toBe('b1')
    expect(errB).not.toBe(errA) // per-call instances, not shared

    // Task A's step-2 result succeeded normally.
    expect(taskAStep2Results).toHaveLength(1)
    expect(taskAStep2Results[0]).toEqual({ status: 'success', key: 'a2', value: 42 })
  })

  it('multi-batch step: batch 1 rejects, batch 2 succeeds -> only batch-1 calls carry batch failures', async () => {
    const boom = new Error('batch 1 down')

    const mockExecutor: StepExecutor = {
      async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
        if (calls[0]?.key === 't0-a') {
          throw boom
        }
        return calls.map((c) => ({ status: 'success' as const, value: 'ok-' + c.key }))
      },
    }

    let t0Results: StepResult[] = []
    let t1Results: StepResult[] = []

    const makeTask = (
      prefix: string,
      sink: (r: StepResult[]) => void,
    ): MultistepTask<StepResult[]> => ({
      maxStep: 1,
      buildStepCalls(step) {
        if (step !== 1) return []
        return [
          { key: prefix + '-a', target: ADDR, abi: [], functionName: 'a' },
          { key: prefix + '-b', target: ADDR, abi: [], functionName: 'b' },
        ]
      },
      consumeStepResults(_step, results) {
        sink(results)
      },
      finalize() {
        return []
      },
    })

    const task0 = makeTask('t0', (r) => (t0Results = r))
    const task1 = makeTask('t1', (r) => (t1Results = r))

    // batchSize 2, 4 total calls (2 per task) -> batch1 = t0's calls, batch2 = t1's calls.
    const results = await runSettled(mockExecutor, [task0, task1], { batchSize: 2 })

    expect(results[0]!.status).toBe('fulfilled')
    expect(results[1]!.status).toBe('fulfilled')

    expect(t0Results).toHaveLength(2)
    for (const r of t0Results) {
      expect(r.status).toBe('failure')
      const err = (r as { status: 'failure'; error?: unknown }).error
      expect(err).toBeInstanceOf(DominoCallError)
      expect((err as DominoCallError).kind).toBe('batch')
      expect((err as DominoCallError).cause).toBe(boom)
    }

    expect(t1Results).toHaveLength(2)
    for (const r of t1Results) {
      expect(r).toEqual({ status: 'success', key: (r as { key: string }).key, value: 'ok-' + (r as { key: string }).key })
    }
  })

  it('multi-batch step: middle batch rejects, both neighbors succeed -> only the middle keys carry batch failures', async () => {
    const boom = new Error('middle batch down')

    const mockExecutor: StepExecutor = {
      async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
        if (calls[0]?.key === 'k1') {
          throw boom
        }
        return calls.map((c) => ({ status: 'success' as const, value: 'ok-' + c.key }))
      },
    }

    const captured: Record<string, StepResult[]> = {}

    const makeTask = (key: string): MultistepTask<StepResult[]> => ({
      maxStep: 1,
      buildStepCalls(step) {
        if (step !== 1) return []
        return [{ key, target: ADDR, abi: [], functionName: 'f' }]
      },
      consumeStepResults(_step, results) {
        captured[key] = results
      },
      finalize() {
        return captured[key] ?? []
      },
    })

    // 3 tasks x 1 call each, batchSize 1 -> 3 physical batches (k0, k1, k2).
    // Only the middle one (k1) rejects.
    const tasks = [makeTask('k0'), makeTask('k1'), makeTask('k2')]

    const results = await runSettled(mockExecutor, tasks, { batchSize: 1 })

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true)

    // Exact set of keys that succeeded: both neighbors, unaffected by the
    // middle batch's rejection (nonzero-batchStart routing on both sides).
    expect(captured['k0']).toEqual([{ status: 'success', key: 'k0', value: 'ok-k0' }])
    expect(captured['k2']).toEqual([{ status: 'success', key: 'k2', value: 'ok-k2' }])

    // Exact set of keys carrying a `batch` failure: only k1.
    expect(captured['k1']).toHaveLength(1)
    const errMid = (captured['k1']![0] as { status: 'failure'; error?: unknown }).error
    expect(errMid).toBeInstanceOf(DominoCallError)
    expect((errMid as DominoCallError).kind).toBe('batch')
    expect((errMid as DominoCallError).cause).toBe(boom)
    expect((errMid as DominoCallError).key).toBe('k1')
  })

  it('consumeStepResults throws for task A at step 1 -> A rejected, dead (no step-2 buildStepCalls), B (maxStep 2) continues its own step-2 routing correctly', async () => {
    const boom = new Error('consume boom')
    let taskABuildStep2Called = false

    // Distinguishable per-key values so step-2 routing correctness for the
    // surviving sibling can be asserted precisely, not just "didn't throw".
    const mockExecutor: StepExecutor = {
      async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
        return calls.map((c) => ({ status: 'success' as const, value: 'val-' + c.key }))
      },
    }

    const taskA: MultistepTask<never> = {
      maxStep: 2,
      buildStepCalls(step) {
        if (step === 1) return [{ key: 'a1', target: ADDR, abi: [], functionName: 'foo' }]
        if (step === 2) {
          taskABuildStep2Called = true
          return [{ key: 'a2', target: ADDR, abi: [], functionName: 'bar' }]
        }
        return []
      },
      consumeStepResults(step) {
        if (step === 1) throw boom
      },
      finalize(): never {
        throw new Error('finalize should never be called for a dead task')
      },
    }

    // B has maxStep 2 (deliberately, per code-review finding) so a real
    // step-2 call/result-routing cycle runs for a surviving lower-priority
    // task AFTER a lower-index task (A) has already died at step 1 — proving
    // dead-task skipping doesn't disturb step-2 dispatch/consumption for
    // everyone else.
    let capturedB1: string | undefined
    let capturedB2: string | undefined
    let taskBStep2Results: StepResult[] = []

    const taskB: MultistepTask<{ step1: string | undefined; step2: string | undefined }> = {
      maxStep: 2,
      buildStepCalls(step) {
        if (step === 1) return [{ key: 'b1', target: ADDR, abi: [], functionName: 'symbol' }]
        if (step === 2) return [{ key: 'b2', target: ADDR, abi: [], functionName: 'decimals' }]
        return []
      },
      consumeStepResults(step, results) {
        if (step === 1) {
          const r = results.find((r) => r.key === 'b1' && r.status === 'success')
          capturedB1 = r?.status === 'success' ? (r.value as string) : undefined
        }
        if (step === 2) {
          taskBStep2Results = results
          const r = results.find((r) => r.key === 'b2' && r.status === 'success')
          capturedB2 = r?.status === 'success' ? (r.value as string) : undefined
        }
      },
      finalize() {
        return { step1: capturedB1, step2: capturedB2 }
      },
    }

    const [resultA, resultB] = await runSettled(mockExecutor, [taskA, taskB])

    expect(resultA).toEqual({
      status: 'rejected',
      error: boom,
      diagnostics: { optionalFailures: [] },
    })
    expect(taskABuildStep2Called).toBe(false)

    // B's step-2 call actually executed and routed the correct value back.
    expect(taskBStep2Results).toEqual([{ status: 'success', key: 'b2', value: 'val-b2' }])
    expect(resultB).toEqual({
      status: 'fulfilled',
      value: { step1: 'val-b1', step2: 'val-b2' },
      diagnostics: { optionalFailures: [] },
    })
  })

  it('buildStepCalls throws for task A -> A rejected, dead, B unaffected', async () => {
    const boom = new Error('build boom')
    let taskAConsumeCalled = false

    const mockExecutor: StepExecutor = {
      async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
        return calls.map(() => ({ status: 'success' as const, value: 'ok' }))
      },
    }

    const taskA: MultistepTask<never> = {
      maxStep: 1,
      buildStepCalls(): StepCall[] {
        throw boom
      },
      consumeStepResults() {
        taskAConsumeCalled = true
      },
      finalize(): never {
        throw new Error('finalize should never be called for a dead task')
      },
    }

    const taskB: MultistepTask<{ v: string }> = {
      maxStep: 1,
      buildStepCalls(step) {
        if (step !== 1) return []
        return [{ key: 'b1', target: ADDR, abi: [], functionName: 'symbol' }]
      },
      consumeStepResults() {},
      finalize() {
        return { v: 'fine' }
      },
    }

    const [resultA, resultB] = await runSettled(mockExecutor, [taskA, taskB])

    expect(resultA).toEqual({
      status: 'rejected',
      error: boom,
      diagnostics: { optionalFailures: [] },
    })
    expect(taskAConsumeCalled).toBe(false)
    expect(resultB!.status).toBe('fulfilled')
  })

  it('batchSize: 0 rejects (validation throws, does not settle)', async () => {
    const mockExecutor: StepExecutor = {
      async executeMulticall(calls: StepCall[]): Promise<RawResult[]> {
        return calls.map(() => ({ status: 'success' as const, value: 'x' }))
      },
    }

    const task: MultistepTask<Record<string, never>> = {
      maxStep: 1,
      buildStepCalls(step) {
        if (step !== 1) return []
        return [{ key: 'a', target: ADDR, abi: [], functionName: 'symbol' }]
      },
      consumeStepResults() {},
      finalize() {
        return {}
      },
    }

    await expect(runSettled(mockExecutor, [task], { batchSize: 0 })).rejects.toThrow(
      'batchSize must be a positive integer',
    )
  })

  it('returns [] for an empty tasks array', async () => {
    const mockExecutor: StepExecutor = {
      async executeMulticall(): Promise<RawResult[]> {
        return []
      },
    }
    const results = await runSettled(mockExecutor, [])
    expect(results).toEqual([])
  })

  it('rejects invalid batchSize even with an empty tasks array (validation runs before the empty-tasks shortcut)', async () => {
    const mockExecutor: StepExecutor = {
      async executeMulticall(): Promise<RawResult[]> {
        return []
      },
    }

    await expect(runSettled(mockExecutor, [], { batchSize: 0 })).rejects.toThrow(
      'batchSize must be a positive integer',
    )
  })
})
