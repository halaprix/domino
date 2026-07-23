import { describe, it, expect } from 'vitest'
import { DominoCallError } from '../core/errors'
import type { DominoCallErrorKind } from '../core/errors'

describe('DominoCallError', () => {
  const kinds: DominoCallErrorKind[] = ['revert', 'decode', 'batch', 'skipped', 'derive']

  it('accepts all five kinds and stores them on .kind', () => {
    for (const kind of kinds) {
      const err = new DominoCallError(`msg for ${kind}`, { kind })
      expect(err.kind).toBe(kind)
    }
  })

  it('sets the message verbatim', () => {
    const err = new DominoCallError('Call foo reverted', { kind: 'revert' })
    expect(err.message).toBe('Call foo reverted')
  })

  it('sets name to DominoCallError', () => {
    const err = new DominoCallError('x', { kind: 'batch' })
    expect(err.name).toBe('DominoCallError')
  })

  it('is an instanceof Error and DominoCallError', () => {
    const err = new DominoCallError('x', { kind: 'derive' })
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(DominoCallError)
  })

  it('preserves cause with the original stack intact', () => {
    const original = new Error('decode boom')
    const err = new DominoCallError('Call foo failed to decode', {
      kind: 'decode',
      cause: original,
    })

    expect(err.cause).toBe(original)
    expect((err.cause as Error).stack).toBe(original.stack)
    expect((err.cause as Error).stack).toBeTruthy()
  })

  it('omits data/target/functionName/key when not passed', () => {
    const err = new DominoCallError('x', { kind: 'batch' })
    expect('data' in err).toBe(false)
    expect('target' in err).toBe(false)
    expect('functionName' in err).toBe(false)
    expect('key' in err).toBe(false)
    expect(err.data).toBeUndefined()
    expect(err.target).toBeUndefined()
    expect(err.functionName).toBeUndefined()
    expect(err.key).toBeUndefined()
  })

  it('sets data/target/functionName/key when passed', () => {
    const err = new DominoCallError('Call bar reverted', {
      kind: 'revert',
      data: '0x08c379a0',
      target: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      functionName: 'totalSupply',
      key: 'bar',
    })

    expect(err.data).toBe('0x08c379a0')
    expect(err.target).toBe('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2')
    expect(err.functionName).toBe('totalSupply')
    expect(err.key).toBe('bar')
  })

  it('has no cause when opts.cause is not passed (revert kind)', () => {
    const err = new DominoCallError('Call baz reverted', {
      kind: 'revert',
      data: '0x',
    })
    expect(err.cause).toBeUndefined()
  })

  it('supports the skipped kind wrapping an upstream DominoCallError as cause', () => {
    const upstream = new DominoCallError('Call up reverted', { kind: 'revert', data: '0x' })
    const err = new DominoCallError('Call down skipped', { kind: 'skipped', cause: upstream })
    expect(err.kind).toBe('skipped')
    expect(err.cause).toBe(upstream)
    expect((err.cause as DominoCallError).kind).toBe('revert')
  })

  it('supports the derive kind wrapping an arbitrary thrown value as cause', () => {
    const thrown = 'not an Error instance'
    const err = new DominoCallError('Call derive failed', { kind: 'derive', cause: thrown })
    expect(err.kind).toBe('derive')
    expect(err.cause).toBe(thrown)
  })

  it('supports the batch kind wrapping a provider/transport error as cause', () => {
    const transportError = new Error('RPC timeout')
    const err = new DominoCallError('Batch failed', { kind: 'batch', cause: transportError })
    expect(err.kind).toBe('batch')
    expect(err.cause).toBe(transportError)
  })
})
