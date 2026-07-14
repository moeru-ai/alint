import type { RunEndPayload } from '@alint-js/core'

import { describe, expect, it } from 'vitest'

import { createStatsCollector, mergeProgressReporters, resolveStatsWrite } from './stats'

const EMPTY_USAGE = { inputTokens: 0, outputTokens: 0, records: [], totalTokens: 0 }

function runEnd(overrides: Partial<RunEndPayload> = {}): RunEndPayload {
  return { cached: 0, completed: 0, diagnostics: [], errored: 0, planned: 0, skipped: 0, usage: EMPTY_USAGE, ...overrides }
}

describe('resolveStatsWrite', () => {
  it('writes to the default stats dir by default', () => {
    const target = resolveStatsWrite(undefined, { XDG_CONFIG_HOME: '/x' })

    expect(target?.dir).toBe('/x/alint/stats')
    expect(target?.retentionMonths).toBeUndefined()
  })

  it('does not write in CI', () => {
    expect(resolveStatsWrite(undefined, { CI: 'true', XDG_CONFIG_HOME: '/x' })).toBeUndefined()
  })

  it('does not write when stats is disabled by flag or config', () => {
    expect(resolveStatsWrite(false, { XDG_CONFIG_HOME: '/x' })).toBeUndefined()
  })

  it('does not write when a config table sets enabled = false', () => {
    expect(resolveStatsWrite({ enabled: false }, { XDG_CONFIG_HOME: '/x' })).toBeUndefined()
  })

  it('honors a custom location and retention', () => {
    const target = resolveStatsWrite({ location: '/custom', retentionMonths: 3 }, { XDG_CONFIG_HOME: '/x' })

    expect(target?.dir).toBe('/custom')
    expect(target?.retentionMonths).toBe(3)
  })
})

describe('createStatsCollector', () => {
  it('captures rule counts and duration from run payloads', () => {
    const collector = createStatsCollector()

    collector.reporter.onRunStart?.({ filesTotal: 1, planned: 3, rulesTotal: 3, startedAt: 1000 })
    collector.reporter.onRunEnd?.(runEnd({ cached: 1, completed: 2, endedAt: 1500, planned: 3 }))

    expect(collector.counts).toEqual({ cached: 1, completed: 2, errored: 0, planned: 3 })
    expect(collector.durationMs()).toBe(500)
  })

  it('leaves duration undefined without timing', () => {
    expect(createStatsCollector().durationMs()).toBeUndefined()
  })
})

describe('mergeProgressReporters', () => {
  it('returns the sole present reporter, or undefined when neither', () => {
    const reporter = { onRunStart: () => {} }

    expect(mergeProgressReporters(undefined, reporter)).toBe(reporter)
    expect(mergeProgressReporters(reporter, undefined)).toBe(reporter)
    expect(mergeProgressReporters(undefined, undefined)).toBeUndefined()
  })

  it('fans a payload out to both reporters', () => {
    let baseCalls = 0
    let extraCalls = 0
    const merged = mergeProgressReporters(
      { onRunEnd: () => void (baseCalls += 1) },
      { onRunEnd: () => void (extraCalls += 1) },
    )

    merged?.onRunEnd?.(runEnd())

    expect(baseCalls).toBe(1)
    expect(extraCalls).toBe(1)
  })
})
