import type { StatsAggregate } from '../../stats'

import { describe, expect, it } from 'vitest'

import { formatStatsChart } from './chart'

function aggregate(overrides: Partial<StatsAggregate> = {}): StatsAggregate {
  return {
    dimension: 'rule',
    rows: [],
    totalIn: 0,
    totalOut: 0,
    totalRuns: 0,
    totalTok: 0,
    ...overrides,
  }
}

describe('formatStatsChart', () => {
  it('reports the empty case without any bars', () => {
    const output = formatStatsChart(aggregate())

    expect(output).toContain('0 runs')
    expect(output).toContain('No stats recorded yet.')
    expect(output).not.toContain('█')
  })

  it('fills the top row and scales the rest against it', () => {
    const output = formatStatsChart(aggregate({
      dimension: 'rule',
      rows: [
        { inTok: 800, key: 'r1', outTok: 0, runs: 4, totalTok: 800 },
        { inTok: 200, key: 'r2', outTok: 0, runs: 1, totalTok: 200 },
      ],
      totalRuns: 4,
      totalTok: 1000,
    }))
    const [, , header, first, second] = output.split('\n')

    expect(header.startsWith('rule')).toBe(true)
    // Top row is the largest, so its bar fills all 32 columns.
    expect(first).toContain('█'.repeat(32))
    expect(first).toContain('80.0%')
    // Second row is a quarter of the max, so a quarter of the bar (8 cells).
    expect(second).toContain('█'.repeat(8))
    expect(second).not.toContain('█'.repeat(9))
    expect(second).toContain('20.0%')
  })

  it('renders a sub-cell sliver instead of an empty bar for tiny rows', () => {
    const output = formatStatsChart(aggregate({
      rows: [
        { inTok: 10000, key: 'big', outTok: 0, runs: 1, totalTok: 10000 },
        { inTok: 1, key: 'tiny', outTok: 0, runs: 1, totalTok: 1 },
      ],
      totalRuns: 1,
      totalTok: 10001,
    }))
    const tinyRow = output.split('\n').find(line => line.startsWith('tiny')) ?? ''

    // 1/10000 of 32 cells rounds to one eighth, not to nothing.
    expect(tinyRow).toContain('▏')
  })

  it('guards a zero total against NaN shares', () => {
    const output = formatStatsChart(aggregate({
      rows: [{ inTok: 0, key: 'r1', outTok: 0, runs: 1, totalTok: 0 }],
      totalRuns: 1,
      totalTok: 0,
    }))
    const row = output.split('\n').find(line => line.startsWith('r1')) ?? ''

    expect(row).toContain('0.0%')
    expect(row).not.toContain('NaN')
  })
})
