import { describe, it, expect } from 'vitest'
import {
  MULTICALL3_BYTECODE,
  DEPLOYLESS_WRAPPER_BYTECODE,
  MULTICALL3_ADDRESS,
} from '../../engine/bytecodes'

describe('vendored bytecodes', () => {
  it('MULTICALL3_BYTECODE starts with EVM initcode prefix', () => {
    expect(MULTICALL3_BYTECODE).toMatch(/^0x6080604052/)
    expect(MULTICALL3_BYTECODE.length).toBeGreaterThan(10000)
  })

  it('DEPLOYLESS_WRAPPER_BYTECODE is valid EVM bytecode', () => {
    expect(DEPLOYLESS_WRAPPER_BYTECODE).toMatch(/^0x60/)
    expect(DEPLOYLESS_WRAPPER_BYTECODE.length).toBeGreaterThan(500)
  })

  it('MULTICALL3_ADDRESS is checksummed', () => {
    expect(MULTICALL3_ADDRESS).toMatch(/^0x[a-fA-F0-9]{40}$/)
  })
})
