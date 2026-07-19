import { describe, expect, it } from 'vitest'

import { formatTokens } from './format'

describe('formatTokens', () => {
  it('keeps counts below 10,000 exact', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(269)).toBe('269')
    expect(formatTokens(9999)).toBe('9,999')
  })

  it('compacts larger counts to k/M/B by default', () => {
    expect(formatTokens(12_345)).toBe('12.35k')
    expect(formatTokens(821_004)).toBe('821.00k')
    expect(formatTokens(1_200_000)).toBe('1.20M')
    expect(formatTokens(3_210_000_000)).toBe('3.21B')
  })

  it('shows full comma-grouped counts when exact', () => {
    expect(formatTokens(12_345, true)).toBe('12,345')
    expect(formatTokens(1_200_000, true)).toBe('1,200,000')
  })
})
