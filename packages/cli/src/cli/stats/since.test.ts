import { describe, expect, it } from 'vitest'

import { parseSince } from './since'

const NOW = Date.UTC(2026, 0, 15)

describe('parseSince', () => {
  it('returns undefined for an empty time', () => {
    expect(parseSince(undefined, NOW)).toBeUndefined()
    expect(parseSince('', NOW)).toBeUndefined()
  })

  it('parses day offsets', () => {
    expect(parseSince('7d', NOW)).toBe(NOW - 7 * 86_400_000)
  })

  it('parses hour offsets', () => {
    expect(parseSince('24h', NOW)).toBe(NOW - 24 * 3_600_000)
  })

  it('parses week offsets', () => {
    expect(parseSince('2w', NOW)).toBe(NOW - 2 * 7 * 86_400_000)
  })

  it('parses month offsets as 30-day windows', () => {
    expect(parseSince('1m', NOW)).toBe(NOW - 30 * 86_400_000)
  })

  it('parses year offsets as 365-day windows', () => {
    expect(parseSince('1y', NOW)).toBe(NOW - 365 * 86_400_000)
  })

  it('parses YYYY-MM as UTC month start', () => {
    expect(parseSince('2025-03', NOW)).toBe(Date.UTC(2025, 2, 1))
  })

  it('parses YYYY-MM-DD as UTC day start', () => {
    expect(parseSince('2025-03-10', NOW)).toBe(Date.UTC(2025, 2, 10))
  })

  it('throws on an unrecognized time', () => {
    expect(() => parseSince('paw', NOW)).toThrow(/Invalid --since/u)
  })
})
