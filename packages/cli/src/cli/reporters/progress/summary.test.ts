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
    target: { identity: `target:${index}`, kind, name },
    total: 3,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('createSummaryProgressReporter', () => {
  it('renders flat running jobs in planned order and reports queued jobs', () => {
    vi.useFakeTimers()
    vi.setSystemTime(2_000)
    const reporter = createReporter()
    const jobs = [job(3, '/repo/src/three.ts'), job(1, '/repo/src/one.ts'), job(2, '/repo/src/two.ts', 'function', 'load')]

    reporter.onRunStart?.({ jobsTotal: 3, startedAt: 0 })
    for (const queued of jobs)
      reporter.onJobQueued?.({ job: queued })
    reporter.onJobStart?.({ job: jobs[0]!, startedAt: 1_800 })
    reporter.onJobStart?.({ job: jobs[1]!, startedAt: 1_000 })

    expect(reporter.getRows()).toEqual([
      '⠋ src/one.ts > file > rule/1 (1.0s)',
      '⠋ src/three.ts > file > rule/3 (0.2s)',
      '',
      '2 running / 1 queued / 0 cached / 0 warn / 0 error / 0 failed / 0 tokens',
    ])
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
      '⠋ src/1.ts > file > rule/1 (0.0s)',
      '    └─ … 2 more running jobs hidden',
      '',
      '3 running / 0 queued / 0 cached / 0 warn / 0 error / 0 failed / 0 tokens',
    ])
  })

  it('keeps a one-row terminal within height and renders nothing at zero rows', () => {
    const oneRow = createReporter(1)
    const zeroRows = createReporter(0)

    for (const reporter of [oneRow, zeroRows]) {
      reporter.onRunStart?.({ jobsTotal: 1 })
      reporter.onJobQueued?.({ job: job(1) })
      reporter.onJobStart?.({ job: job(1) })
    }

    expect(oneRow.getRows()).toEqual(['1 running / 0 queued / 0 cached / 0 warn / 0 error / 0 failed / 0 tokens'])
    expect(zeroRows.getRows()).toEqual([])
  })

  it('removes jobs for every terminal transition and uses final run counts', () => {
    const reporter = createReporter()
    const terminalStates = ['cached', 'cancelled', 'completed', 'failed', 'skipped'] as const

    reporter.onRunStart?.({ jobsTotal: terminalStates.length })
    terminalStates.forEach((state, index) => {
      const current = job(index + 1)
      reporter.onJobQueued?.({ job: current })
      reporter.onJobStart?.({ job: current })
      reporter.onJobEnd?.({ cache: state === 'cached' ? 'hit' : 'miss', job: current, state })
    })

    expect(reporter.getRows().join('\n')).not.toContain('rule/')

    reporter.onRunEnd?.({
      diagnostics: [],
      execution: counts({ cached: 1, cancelled: 1, completed: 1, failed: 1, planned: 5, skipped: 1 }),
      usage: { inputTokens: 2, outputTokens: 3, records: [], totalTokens: 5 },
    })
    expect(reporter.getRows().at(-1)).toBe('0 running / 0 queued / 1 cached / 0 warn / 0 error / 1 failed / 5 tokens')
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

    expect(reporter.getRows().at(-1)).toBe('0 running / 1 queued / 0 cached / 1 warn / 1 error / 0 failed / 7 tokens')
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
    expect(rows[0]).toContain('\u001B[0m…')

    const colored = createSummaryProgressReporter({ color: true, columns: 120, cwd: '/repo', spinnerFrames: ['⠋'] })
    colored.onRunStart?.({ jobsTotal: 1 })
    colored.onJobQueued?.({ job: current })
    colored.onJobStart?.({ job: current })
    colored.onDiagnostic?.({ diagnostic: { filePath: current.inputPath, message: 'failure', ruleId: current.ruleId, severity: 'error' }, job: current })

    expect(colored.getRows()[0]).toContain('\u001B[36m⠋')
    expect(colored.getRows().at(-1)).toContain('\u001B[31m1 error')
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
