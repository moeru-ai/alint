import type { ExecutionCounts, ProgressJob } from '@alint-js/core'

import fastStringWidth from 'fast-string-width'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createSummaryProgressReporter } from './summary'

function counts(overrides: Partial<ExecutionCounts> = {}): ExecutionCounts {
  return {
    cached: 0,
    cancelled: 0,
    completed: 0,
    failed: 0,
    planned: 0,
    queued: 0,
    running: 0,
    skipped: 0,
    ...overrides,
  }
}

function createReporter(rows?: number) {
  return createSummaryProgressReporter({
    color: false,
    columns: 120,
    cwd: '/repo',
    rows,
    spinnerFrames: ['⠋', '⠙'],
  })
}

function job(index: number, inputPath = `/repo/src/${index}.ts`, kind: ProgressJob['target']['kind'] = 'file', name?: string): ProgressJob {
  return {
    id: `job:${index}`,
    index,
    inputPath,
    ruleId: `rule/${index}`,
    ruleIndex: index,
    ruleTotal: 1,
    target: { identity: `target:${index}`, kind, name },
    total: 3,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('createSummaryProgressReporter', () => {
  it('renders active jobs grouped by rule with target rows and collapsed overflow', () => {
    vi.useFakeTimers()
    vi.setSystemTime(50_000)
    const reporter = createSummaryProgressReporter({
      color: false,
      columns: 140,
      cwd: '/repo',
      rows: 8,
      spinnerFrames: ['⠋', '⠙'],
    })
    const first = { ...job(1, '/repo/alint.config.ts'), ruleId: 'js/no-redundant-jsdoc', ruleIndex: 1, ruleTotal: 2 }
    const second = { ...job(2, '/repo/packages/cli/src/cli/stats/index.ts'), ruleId: 'js/no-redundant-jsdoc', ruleIndex: 2, ruleTotal: 2 }
    const third = { ...job(3, '/repo/packages/core/src/core/run.ts'), ruleId: 'js/no-vacuous-function', ruleIndex: 1, ruleTotal: 1 }

    reporter.onRunStart?.({ jobsTotal: 10, startedAt: 0 })
    for (const current of [first, second, third])
      reporter.onJobQueued?.({ job: current })
    reporter.onJobStart?.({ job: first, startedAt: 47_400 })
    reporter.onJobStart?.({ job: second, startedAt: 7_200 })
    reporter.onJobStart?.({ job: third, startedAt: 43_000 })
    reporter.onJobRetry?.({ attempt: 1, job: first, maxAttempts: 3, startedAt: 47_400 })

    expect(reporter.getRows()).toEqual([
      '⠋ js/no-redundant-jsdoc 0/2 0% [░░░░░░░░░░] eta ? 2 running',
      '   ├─ packages/cli/src/cli/stats/index.ts > file running 42.8s',
      '   └─ 1 more running',
      '⠋ js/no-vacuous-function 0/1 0% [░░░░░░░░░░] eta ? 1 running',
      '',
      '0/10 [░░░░░░░░░░] 50.0s -> ~?',
      '3 concurrency / 0 queued / 0 cached / 0 failed',
      '0 tokens (0 cached) -> ~?',
    ])
  })

  it('renders failed non-running groups after active groups and orders them by failed count', () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const reporter = createSummaryProgressReporter({
      color: false,
      columns: 140,
      cwd: '/repo',
      rows: 8,
      spinnerFrames: ['⠋'],
    })
    const active = { ...job(1, '/repo/src/active.ts'), ruleId: 'rule/active', ruleIndex: 1, ruleTotal: 1 }
    const oneFailure = { ...job(2, '/repo/src/one-failure.ts'), ruleId: 'rule/one-failure', ruleIndex: 1, ruleTotal: 1 }
    const firstFailure = { ...job(3, '/repo/src/first-failure.ts'), ruleId: 'rule/two-failures', ruleIndex: 1, ruleTotal: 2 }
    const secondFailure = { ...job(4, '/repo/src/second-failure.ts'), ruleId: 'rule/two-failures', ruleIndex: 2, ruleTotal: 2 }

    reporter.onRunStart?.({ jobsTotal: 4, startedAt: 0 })
    for (const current of [active, oneFailure, firstFailure, secondFailure])
      reporter.onJobQueued?.({ job: current })
    reporter.onJobStart?.({ job: active, startedAt: 9_000 })
    reporter.onJobStart?.({ job: oneFailure, startedAt: 1_000 })
    reporter.onJobEnd?.({ cache: 'miss', endedAt: 2_000, job: oneFailure, startedAt: 1_000, state: 'failed' })
    reporter.onJobStart?.({ job: firstFailure, startedAt: 3_000 })
    reporter.onJobEnd?.({ cache: 'miss', endedAt: 4_000, job: firstFailure, startedAt: 3_000, state: 'failed' })
    reporter.onJobStart?.({ job: secondFailure, startedAt: 5_000 })
    reporter.onJobEnd?.({ cache: 'miss', endedAt: 6_000, job: secondFailure, startedAt: 5_000, state: 'failed' })

    expect(reporter.getRows()).toEqual([
      '⠋ rule/active 0/1 0% [░░░░░░░░░░] eta ? 1 running',
      '⠋ rule/two-failures 2/2 100% [██████████] eta ~0.0s 0 running 2 failed',
      '⠋ rule/one-failure 1/1 100% [██████████] eta ~0.0s 0 running 1 failed',
      '',
      '3/4 [▓███████░░] 10.0s -> ~3.3s',
      '1 concurrency / 0 queued / 0 cached / 3 failed',
      '0 tokens (0 cached) -> ~0 tokens',
    ])
  })

  it('keeps active rule groups visible under constrained height', () => {
    vi.useFakeTimers()
    vi.setSystemTime(20_000)
    const reporter = createSummaryProgressReporter({
      color: false,
      columns: 140,
      cwd: '/repo',
      rows: 8,
      spinnerFrames: ['⠋'],
    })
    const first = { ...job(1, '/repo/src/first.ts'), ruleId: 'rule/first' }
    const second = { ...job(2, '/repo/src/second.ts'), ruleId: 'rule/second' }
    const third = { ...job(3, '/repo/src/third.ts'), ruleId: 'rule/third' }

    reporter.onRunStart?.({ jobsTotal: 3, startedAt: 0 })
    for (const current of [first, second, third]) {
      reporter.onJobQueued?.({ job: current })
      reporter.onJobStart?.({ job: current, startedAt: 19_000 })
    }

    expect(reporter.getRows()).toEqual([
      '⠋ rule/first 0/1 0% [░░░░░░░░░░] eta ? 1 running',
      '⠋ rule/second 0/1 0% [░░░░░░░░░░] eta ? 1 running',
      '⠋ rule/third 0/1 0% [░░░░░░░░░░] eta ? 1 running',
      '',
      '0/3 [░░░░░░░░░░] 20.0s -> ~?',
      '3 concurrency / 0 queued / 0 cached / 0 failed',
      '0 tokens (0 cached) -> ~?',
    ])
  })

  it('renders footer progress, token projection, and semantic colors', () => {
    const reporter = createSummaryProgressReporter({
      color: true,
      columns: 160,
      cwd: '/repo',
      spinnerFrames: ['⠋'],
    })
    const current = { ...job(1), ruleId: 'js/rule' }

    reporter.onRunStart?.({ jobsTotal: 4, startedAt: 0 })
    reporter.onJobQueued?.({ job: current })
    reporter.onJobStart?.({ job: current, startedAt: 0 })
    reporter.onUsage?.({ job: current, record: { inputTokens: 100, modelId: 'model', outputTokens: 20, providerId: 'provider', ruleId: current.ruleId, totalTokens: 120 } })
    reporter.onJobEnd?.({ cache: 'miss', job: current, startedAt: 0, state: 'failed' })
    reporter.onRunEnd?.({
      diagnostics: [],
      execution: counts({ failed: 1, planned: 4 }),
      startedAt: 0,
      usage: {
        cached: { inputTokens: 50, outputTokens: 10, records: [], totalTokens: 60 },
        inputTokens: 100,
        outputTokens: 20,
        records: [],
        totalTokens: 120,
      },
    })

    const rows = reporter.getRows()
    expect(rows.at(-2)).toContain('\u001B[36m0 concurrency\u001B[39m')
    expect(rows.at(-2)).toContain('0 queued')
    expect(rows.at(-2)).toContain('\u001B[2m0 cached\u001B[22m')
    expect(rows.at(-2)).toContain('\u001B[31m1 failed\u001B[39m')
    expect(rows.at(-1)).toContain('\u001B[36m120 tokens\u001B[39m')
    expect(rows.at(-1)).toContain('\u001B[2m(60 cached)\u001B[22m')
    expect(rows.join('\n')).toMatch(/\u001B\[(?:2|90)m░+/)
  })

  it('keeps animation gap cells default and colors only pending tail cells gray', () => {
    const reporter = createSummaryProgressReporter({
      color: true,
      columns: 160,
      cwd: '/repo',
      spinnerFrames: ['⠋', '⠙', '⠹', '⠸'],
    })

    reporter.onRunStart?.({ jobsTotal: 10, startedAt: 0 })
    for (let index = 1; index <= 5; index++) {
      const current = { ...job(index), ruleId: 'rule/progress', ruleIndex: index, ruleTotal: 10 }
      reporter.onJobQueued?.({ job: current })
      reporter.onJobStart?.({ job: current, startedAt: 0 })
      reporter.onJobEnd?.({ cache: 'miss', job: current, startedAt: 0, state: 'completed' })
    }

    reporter.tick()
    reporter.tick()
    reporter.tick()

    const rows = reporter.getRows().join('\n')
    expect(rows).toContain('███▓░█')
    expect(rows).toContain(`▓░█\u001B[90m░░░░\u001B[39m]`)
  })

  it('drops the mini bar before important footer text on narrow terminals', () => {
    vi.useFakeTimers()
    vi.setSystemTime(50_000)
    const reporter = createSummaryProgressReporter({
      color: false,
      columns: 42,
      cwd: '/repo',
      rows: 4,
      spinnerFrames: ['⠋'],
    })
    const current = { ...job(1, '/repo/alint.config.ts'), ruleId: 'js/no-redundant-jsdoc' }

    reporter.onRunStart?.({ jobsTotal: 10, startedAt: 0 })
    reporter.onJobQueued?.({ job: current })
    reporter.onJobStart?.({ job: current, startedAt: 47_400 })

    const rows = reporter.getRows()
    expect(rows).toEqual([
      '   └─ 1 more running',
      '0/10 50.0s -> ~?',
      '1 concurrency / 0 queued / 0 cached / 0 f…',
      '0 tokens (0 cached) -> ~?',
    ])
    expect(rows.every(row => !row.includes('[▓') && !row.includes('[█'))).toBe(true)
  })

  it('counts cached job usage as cached tokens after cached completion', () => {
    const reporter = createSummaryProgressReporter({
      color: false,
      columns: 160,
      cwd: '/repo',
      spinnerFrames: ['⠋'],
    })
    const current = { ...job(1), ruleId: 'js/cached-rule' }

    reporter.onRunStart?.({ jobsTotal: 1, startedAt: 0 })
    reporter.onJobQueued?.({ job: current })
    reporter.onJobStart?.({ job: current, startedAt: 0 })
    reporter.onUsage?.({ job: current, record: { inputTokens: 8, modelId: 'model', outputTokens: 2, providerId: 'provider', ruleId: current.ruleId, totalTokens: 10 } })
    reporter.onJobEnd?.({ cache: 'hit', job: current, startedAt: 0, state: 'cached' })

    expect(reporter.getRows().at(-1)).toBe('0 tokens (10 cached) -> ~10 tokens')
  })

  it('counts cancelled and skipped jobs as terminal rule progress', () => {
    const reporter = createSummaryProgressReporter({
      color: false,
      columns: 160,
      cwd: '/repo',
      spinnerFrames: ['⠋'],
    })
    const failed = { ...job(1, '/repo/src/failed.ts'), ruleId: 'rule/terminal', ruleIndex: 1, ruleTotal: 3 }
    const cancelled = { ...job(2, '/repo/src/cancelled.ts'), ruleId: 'rule/terminal', ruleIndex: 2, ruleTotal: 3 }
    const skipped = { ...job(3, '/repo/src/skipped.ts'), ruleId: 'rule/terminal', ruleIndex: 3, ruleTotal: 3 }

    reporter.onRunStart?.({ jobsTotal: 3, startedAt: 0 })
    for (const current of [failed, cancelled, skipped]) {
      reporter.onJobQueued?.({ job: current })
      reporter.onJobStart?.({ job: current, startedAt: 0 })
    }
    reporter.onJobEnd?.({ cache: 'miss', endedAt: 1_000, job: failed, startedAt: 0, state: 'failed' })
    reporter.onJobEnd?.({ cache: 'miss', endedAt: 2_000, job: cancelled, startedAt: 0, state: 'cancelled' })
    reporter.onJobEnd?.({ cache: 'miss', endedAt: 3_000, job: skipped, startedAt: 0, state: 'skipped' })

    expect(reporter.getRows()[0]).toBe('⠋ rule/terminal 3/3 100% [██████████] eta ~0.0s 0 running 1 failed')
  })

  it('limits rows, reports hidden jobs, and preserves the footer', () => {
    const reporter = createReporter(4)
    const jobs = [job(1), job(2), job(3)]

    reporter.onRunStart?.({ jobsTotal: jobs.length })
    for (const running of jobs) {
      reporter.onJobQueued?.({ job: running })
      reporter.onJobStart?.({ job: running })
    }

    expect(reporter.getRows()).toEqual([
      '   └─ 3 more running',
      '0/3 [░░░░░░░░░░] 0.0s -> ~?',
      '3 concurrency / 0 queued / 0 cached / 0 failed',
      '0 tokens (0 cached) -> ~?',
    ])
  })

  it('uses a collapsed active summary when only one content row fits', () => {
    const reporter = createReporter(5)
    const jobs = [
      { ...job(1), ruleId: 'rule/first' },
      { ...job(2), ruleId: 'rule/second' },
      { ...job(3), ruleId: 'rule/third' },
    ]

    reporter.onRunStart?.({ jobsTotal: jobs.length })
    for (const running of jobs) {
      reporter.onJobQueued?.({ job: running })
      reporter.onJobStart?.({ job: running, startedAt: 0 })
    }

    expect(reporter.getRows()).toEqual([
      '   └─ 3 more running',
      '',
      '0/3 [░░░░░░░░░░] 0.0s -> ~?',
      '3 concurrency / 0 queued / 0 cached / 0 failed',
      '0 tokens (0 cached) -> ~?',
    ])
  })

  it('prioritizes failed rule identity when one content row fits', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const reporter = createReporter(5)
    const running = { ...job(1), ruleId: 'rule/running' }
    const failed = { ...job(2), ruleId: 'rule/failed' }

    reporter.onRunStart?.({ jobsTotal: 2 })
    for (const current of [running, failed]) {
      reporter.onJobQueued?.({ job: current })
      reporter.onJobStart?.({ job: current, startedAt: 0 })
    }
    reporter.onJobEnd?.({ cache: 'miss', endedAt: 1_000, job: failed, startedAt: 0, state: 'failed' })

    const rows = reporter.getRows()
    expect(rows).toEqual([
      '⠋ rule/failed 1/1 100% [██████████] eta ~0.0s 0 running 1 failed',
      '',
      '1/2 [▓█████░░░░] 0.0s -> ~?',
      '1 concurrency / 0 queued / 0 cached / 1 failed',
      '0 tokens (0 cached) -> ~0 tokens',
    ])
    expect(rows.length).toBeLessThanOrEqual(5)
  })

  it('keeps a one-row terminal within height and renders nothing at zero rows', () => {
    const oneRow = createReporter(1)
    const zeroRows = createReporter(0)

    for (const reporter of [oneRow, zeroRows]) {
      reporter.onRunStart?.({ jobsTotal: 1 })
      reporter.onJobQueued?.({ job: job(1) })
      reporter.onJobStart?.({ job: job(1) })
    }

    expect(oneRow.getRows()).toEqual(['0/1 [░░░░░░░░░░] 0.0s -> ~?'])
    expect(zeroRows.getRows()).toEqual([])
  })

  it('removes jobs for every terminal transition and uses final run counts', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const reporter = createReporter()
    const terminalStates = ['cached', 'cancelled', 'completed', 'failed', 'skipped'] as const

    reporter.onRunStart?.({ jobsTotal: terminalStates.length })
    terminalStates.forEach((state, index) => {
      const current = job(index + 1)
      reporter.onJobQueued?.({ job: current })
      reporter.onJobStart?.({ job: current })
      reporter.onJobEnd?.({ cache: state === 'cached' ? 'hit' : 'miss', job: current, state })
    })

    expect(reporter.getRows()).toEqual([
      '⠋ rule/4 1/1 100% [██████████] eta ? 0 running 1 failed',
      '',
      '5/5 [██████████] 0.0s -> ~?',
      '0 concurrency / 0 queued / 1 cached / 1 failed',
      '0 tokens (0 cached) -> ~0 tokens',
    ])

    reporter.onRunEnd?.({
      diagnostics: [],
      execution: counts({ cached: 1, cancelled: 1, completed: 1, failed: 1, planned: 5, skipped: 1 }),
      usage: { inputTokens: 2, outputTokens: 3, records: [], totalTokens: 5 },
    })
    expect(reporter.getRows()).toEqual([
      '⠋ rule/4 1/1 100% [██████████] eta ? 0 running 1 failed',
      '',
      '5/5 [██████████] 0.0s -> ~?',
      '0 concurrency / 0 queued / 1 cached / 1 failed',
      '5 tokens (0 cached) -> ~5 tokens',
    ])
  })

  it('accumulates diagnostics and finite usage tokens', () => {
    const reporter = createReporter()
    const current = job(1)

    reporter.onRunStart?.({ jobsTotal: 1 })
    reporter.onJobQueued?.({ job: current })
    reporter.onDiagnostic?.({ diagnostic: { filePath: current.inputPath, message: 'warned', ruleId: current.ruleId, severity: 'warn' }, job: current })
    reporter.onDiagnostic?.({ diagnostic: { filePath: current.inputPath, message: 'errored', ruleId: current.ruleId, severity: 'error' }, job: current })
    reporter.onUsage?.({ job: current, record: { inputTokens: 3, modelId: 'model', outputTokens: 4, providerId: 'provider', ruleId: current.ruleId, totalTokens: 7 } })
    reporter.onUsage?.({ job: current, record: { inputTokens: Number.NaN, modelId: 'model', outputTokens: 2, providerId: 'provider', ruleId: current.ruleId } })

    expect(reporter.getRows().at(-1)).toBe('7 tokens (0 cached) -> ~?')
  })

  it('preserves width-safe grapheme and ANSI truncation and semantic color', () => {
    const current = job(1, '/repo/\u001B[31m中文目录😀😀😀😀😀\u001B[39m/文件.ts', 'function', '解析中文😀')
    current.ruleId = '\u001B[31m规则😀😀😀😀😀😀😀😀\u001B[39m'
    const reporter = createSummaryProgressReporter({ color: false, columns: 32, cwd: '/repo', spinnerFrames: ['⠋'] })

    reporter.onRunStart?.({ jobsTotal: 1 })
    reporter.onJobQueued?.({ job: current })
    reporter.onJobStart?.({ job: current })

    const rows = reporter.getRows()
    expect(rows.every(row => fastStringWidth(row) <= 32)).toBe(true)
    expect(rows[0]).not.toMatch(/\u001B(?:\[[0-9;]*)?$/)
    expect(rows[0]).not.toMatch(/[\uD800-\uDBFF]$/)
    expect(rows.some(row => row.includes('…'))).toBe(true)

    const colored = createSummaryProgressReporter({ color: true, columns: 120, cwd: '/repo', spinnerFrames: ['⠋'] })
    colored.onRunStart?.({ jobsTotal: 1 })
    colored.onJobQueued?.({ job: current })
    colored.onJobStart?.({ job: current })
    colored.onDiagnostic?.({ diagnostic: { filePath: current.inputPath, message: 'failure', ruleId: current.ruleId, severity: 'error' }, job: current })

    expect(colored.getRows()[0]).toContain('\u001B[36m⠋')
    expect(colored.getRows().at(-2)).toContain('\u001B[36m1 concurrency')
  })

  it('continues the bar sweep when the spinner frame wraps', () => {
    const reporter = createSummaryProgressReporter({
      color: false,
      columns: 120,
      cwd: '/repo',
      spinnerFrames: ['⠋', '⠙'],
    })

    reporter.onRunStart?.({ jobsTotal: 10, startedAt: 0 })
    for (let index = 1; index <= 5; index++) {
      const current = { ...job(index), ruleId: 'rule/progress', ruleIndex: index, ruleTotal: 10 }
      reporter.onJobQueued?.({ job: current })
      reporter.onJobStart?.({ job: current, startedAt: 0 })
      reporter.onJobEnd?.({ cache: 'miss', job: current, startedAt: 0, state: 'completed' })
    }

    const running = { ...job(6), ruleId: 'rule/progress', ruleIndex: 6, ruleTotal: 10 }
    reporter.onJobQueued?.({ job: running })
    reporter.onJobStart?.({ job: running, startedAt: 0 })
    reporter.tick()
    reporter.tick()

    expect(reporter.getRows()[0]).toContain('⠋ rule/progress 5/10 50% [██▓░██░░░░]')
  })

  it('resets the spinner frame on run start', () => {
    const reporter = createReporter()
    reporter.tick()
    reporter.onRunStart?.({ jobsTotal: 1 })
    reporter.onJobQueued?.({ job: job(1) })
    reporter.onJobStart?.({ job: job(1) })

    expect(reporter.getRows()[0]?.startsWith('⠋ ')).toBe(true)
  })
})
