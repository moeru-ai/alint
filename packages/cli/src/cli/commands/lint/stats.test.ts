import type { PlanProgressPayload, RunEndPayload } from '@alint-js/core'

import { describe, expect, it } from 'vitest'

import { createStatsCollector, mergeProgressReporters, resolveStatsWrite } from './stats'

const EMPTY_USAGE = { inputTokens: 0, outputTokens: 0, records: [], totalTokens: 0 }

describe('resolveStatsWrite', () => {
  it('uses the default stats directory', () => {
    expect(resolveStatsWrite(undefined, { XDG_CONFIG_HOME: '/x' })).toEqual({
      dir: '/x/alint/stats',
      retentionMonths: undefined,
    })
  })

  it('does not write in CI or when disabled', () => {
    expect(resolveStatsWrite(undefined, { CI: 'true', XDG_CONFIG_HOME: '/x' })).toBeUndefined()
    expect(resolveStatsWrite(false, { XDG_CONFIG_HOME: '/x' })).toBeUndefined()
    expect(resolveStatsWrite({ enabled: false }, { XDG_CONFIG_HOME: '/x' })).toBeUndefined()
  })

  it('honors a custom location and retention', () => {
    expect(resolveStatsWrite({ location: '/custom', retentionMonths: 3 }, {})).toEqual({
      dir: '/custom',
      retentionMonths: 3,
    })
  })
})

describe('createStatsCollector', () => {
  it('captures final counts and duration', () => {
    const collector = createStatsCollector()
    collector.reporter.onRunStart?.({
      execution: counts({ planned: 5, queued: 5 }),
      plans: [],
      rulesTotal: 3,
      startedAt: 1000,
    })
    collector.reporter.onRunEnd?.(runEnd({
      endedAt: 1500,
      execution: counts({ cached: 1, cancelled: 1, completed: 1, failed: 2, planned: 5 }),
    }))

    expect(collector.counts).toEqual({ cached: 1, cancelled: 1, completed: 1, failed: 2, planned: 5 })
    expect(collector.durationMs()).toBe(500)
  })

  it('leaves duration undefined without timing', () => {
    expect(createStatsCollector().durationMs()).toBeUndefined()
  })
})

describe('mergeProgressReporters', () => {
  it('returns the sole reporter or undefined', () => {
    const reporter = { onRunStart: () => {} }
    expect(mergeProgressReporters(undefined, reporter)).toBe(reporter)
    expect(mergeProgressReporters()).toBeUndefined()
  })

  it('fans payloads out to both reporters', () => {
    const events: string[] = []
    const merged = mergeProgressReporters(
      { onRunEnd: () => events.push('base') },
      { onRunEnd: () => events.push('extra') },
    )

    merged?.onRunEnd?.(runEnd())

    expect(events).toEqual(['base', 'extra'])
  })

  it('isolates a failed consumer while the other receives current and later events', () => {
    const cause = new Error('UI failed')
    const baseEvents: string[] = []
    const extraEvents: string[] = []
    const merged = mergeProgressReporters(
      {
        onPlanStart: () => {
          baseEvents.push('plan:start')
          throw cause
        },
        onRunEnd: () => baseEvents.push('run:end'),
      },
      {
        onPlanStart: () => extraEvents.push('plan:start'),
        onRunEnd: () => extraEvents.push('run:end'),
      },
    )

    merged?.onPlanStart?.(planStart())

    expect(() => merged?.onRunEnd?.(runEnd())).toThrow(cause)
    expect(baseEvents).toEqual(['plan:start'])
    expect(extraEvents).toEqual(['plan:start', 'run:end'])
  })

  it('normalizes one nullish consumer failure after delivering to both', () => {
    const events: string[] = []
    const merged = mergeProgressReporters(
      {
        onRunEnd: () => {
          events.push('base')
          throwValue(null)
        },
      },
      { onRunEnd: () => events.push('extra') },
    )

    expect(() => merged?.onRunEnd?.(runEnd())).toThrow(new Error('Unknown progress reporter error.'))
    expect(events).toEqual(['base', 'extra'])
  })
})

function counts(overrides: Partial<RunEndPayload['execution']>): RunEndPayload['execution'] {
  return { cached: 0, cancelled: 0, completed: 0, failed: 0, planned: 0, queued: 0, running: 0, skipped: 0, ...overrides }
}

function planStart(): PlanProgressPayload {
  return {
    execution: counts({ planned: 1, running: 1 }),
    plan: { id: 'source:0', index: 0, kind: 'source', path: '/repo/a.ts', planned: 1, total: 1 },
  }
}

function runEnd(overrides: Partial<RunEndPayload> = {}): RunEndPayload {
  return {
    diagnostics: [],
    execution: counts({}),
    usage: EMPTY_USAGE,
    ...overrides,
  }
}

function throwValue(value: unknown): never {
  throw value
}
