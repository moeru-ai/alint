import type { ExecutionCounts, ProgressPath, ProgressPlanRef } from '@alint-js/core'

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

function normalized(rows: string[]): string[] {
  return rows.map(row => row.replace(/\s+(?=\d+\/\d+\/\d+\/\d+$)/, ' '))
}

function path(planRef: ProgressPlanRef, jobIndex: number, kind: ProgressPath['target']['kind'], ruleId: string, name?: string): ProgressPath {
  return {
    job: { index: jobIndex, total: 3 },
    plan: planRef,
    rule: { id: ruleId, index: jobIndex, total: 3 },
    target: { identity: `target:${jobIndex}`, index: jobIndex, kind, name, total: 3 },
  }
}

function plan(index: number, path: string, planned: number, kind: ProgressPlanRef['kind'] = 'source'): ProgressPlanRef {
  return { id: `plan:${index}`, index, kind, path, planned, total: 2 }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('createSummaryProgressReporter', () => {
  it('groups concurrent jobs by plan and sorts plans and children by planned index', () => {
    vi.useFakeTimers()
    vi.setSystemTime(2_000)
    const reporter = createReporter()
    const source = plan(1, '/repo/src/one.ts', 2)
    const project = plan(2, '/repo', 1, 'project')
    const fileJob = path(source, 1, 'file', 'rule/a')
    const functionJob = path(source, 2, 'function', 'rule/b', 'f')
    const projectJob = path(project, 3, 'project', 'rule/p')

    reporter.onRunStart?.({ execution: counts({ planned: 3, queued: 3 }), plans: [source, project], rulesTotal: 3, startedAt: 0 })
    reporter.onPlanStart?.({ execution: counts({ planned: 1, running: 1 }), plan: project, startedAt: 1_800 })
    reporter.onRuleStart?.({ path: projectJob, startedAt: 1_800 })
    reporter.onPlanStart?.({ execution: counts({ planned: 2, queued: 1, running: 1 }), plan: source, startedAt: 1_000 })
    reporter.onRuleStart?.({ path: functionJob, startedAt: 1_500 })
    reporter.onRuleStart?.({ path: fileJob, startedAt: 1_000 })

    expect(normalized(reporter.getRows())).toEqual([
      '⠋ src/one.ts 0/0/0/2',
      '    file > rule/a (1.0s)',
      '    function f > rule/b (0.5s)',
      '⠋ . 0/0/0/1',
      '    project > rule/p (0.2s)',
      '',
      '3 running / 0 queued / 0 cached / 0 warn / 0 error / 0 failed',
    ])
  })

  it('uses exclusive terminal counts in parent rows and real run counts in the footer', () => {
    const reporter = createReporter()
    const source = plan(1, '/repo/src/one.ts', 4)
    const first = path(source, 1, 'file', 'rule/a')
    const second = path(source, 2, 'file', 'rule/b')

    reporter.onRunStart?.({ execution: counts({ planned: 4, queued: 4 }), plans: [source], rulesTotal: 2 })
    reporter.onPlanStart?.({ execution: counts({ cached: 1, completed: 1, planned: 4, queued: 1, running: 1 }), plan: source })
    reporter.onRuleStart?.({ path: first })
    reporter.onRuleEnd?.({ cache: 'miss', path: first, state: 'failed' })
    reporter.onRuleStart?.({ path: second })
    reporter.onDiagnostic?.({
      diagnostic: { filePath: source.path, message: 'warning', ruleId: 'rule/b', severity: 'warn' },
      diagnostics: [{ filePath: source.path, message: 'warning', ruleId: 'rule/b', severity: 'warn' }],
      path: second,
    })

    const rows = normalized(reporter.getRows())
    expect(rows[0]).toBe('⠋ src/one.ts 1/1/1/4')
    expect(rows.at(-1)).toBe('1 running / 0 queued / 1 cached / 1 warn / 0 error / 1 failed')
  })

  it('does not subtract declared plan totals when the actual plan snapshot differs', () => {
    const reporter = createReporter()
    const source = plan(1, '/repo/src/one.ts', 9)

    reporter.onRunStart?.({ execution: counts({ planned: 3, queued: 3 }), plans: [source], rulesTotal: 3 })
    reporter.onPlanStart?.({ execution: counts({ planned: 3, queued: 2, running: 1 }), plan: source })

    expect(reporter.getRows().at(-1)).toBe('1 running / 2 queued / 0 cached / 0 warn / 0 error / 0 failed')
  })

  it('selects only complete plan blocks and reports the exact hidden running job count', () => {
    const reporter = createReporter(7)
    const plans = [plan(1, '/repo/one.ts', 2), plan(2, '/repo/two.ts', 2), plan(3, '/repo/three.ts', 1)]
    const jobs = [
      path(plans[0]!, 1, 'file', 'visible/a'),
      path(plans[0]!, 2, 'function', 'visible/b', 'f'),
      path(plans[1]!, 3, 'file', 'rule-without-visible-parent/a'),
      path(plans[1]!, 4, 'class', 'rule-without-visible-parent/b', 'C'),
      path(plans[2]!, 5, 'project', 'rule-without-visible-parent/c'),
    ]

    reporter.onRunStart?.({ execution: counts({ planned: 5, queued: 5 }), plans, rulesTotal: 5 })
    for (const [index, planRef] of plans.entries()) {
      const running = index < 2 ? 2 : 1
      reporter.onPlanStart?.({ execution: counts({ planned: running, running }), plan: planRef })
    }
    for (const job of jobs)
      reporter.onRuleStart?.({ path: job })

    const rows = reporter.getRows()
    expect(rows.length).toBeLessThanOrEqual(7)
    expect(rows.at(-3)).toBe('    └─ … 3 more running rules hidden')
    expect(rows.at(-1)).toContain('5 running')
    expect(rows.some(row => row.includes('rule-without-visible-parent'))).toBe(false)
  })

  it('renders every active job when terminal rows are unavailable', () => {
    const reporter = createReporter(undefined)
    const plans = [plan(1, '/repo/one.ts', 2), plan(2, '/repo/two.ts', 1)]
    const jobs = [
      path(plans[0]!, 1, 'file', 'rule/a'),
      path(plans[0]!, 2, 'function', 'rule/b', 'f'),
      path(plans[1]!, 3, 'project', 'rule/c'),
    ]

    reporter.onRunStart?.({ execution: counts({ planned: 3, queued: 3 }), plans, rulesTotal: 3 })
    reporter.onPlanStart?.({ execution: counts({ planned: 2, running: 2 }), plan: plans[0]! })
    reporter.onPlanStart?.({ execution: counts({ planned: 1, running: 1 }), plan: plans[1]! })
    for (const job of jobs)
      reporter.onRuleStart?.({ path: job })

    const output = reporter.getRows().join('\n')
    expect(output).toContain('rule/a')
    expect(output).toContain('rule/b')
    expect(output).toContain('rule/c')
    expect(output).not.toContain('more running rules hidden')
  })

  it('keeps a one-row terminal within height and preserves the footer', () => {
    const reporter = createReporter(1)
    const source = plan(1, '/repo/src/one.ts', 1)
    const job = path(source, 1, 'file', 'rule/a')

    reporter.onRunStart?.({ execution: counts({ planned: 1, queued: 1 }), plans: [source], rulesTotal: 1 })
    reporter.onPlanStart?.({ execution: counts({ planned: 1, running: 1 }), plan: source })
    reporter.onRuleStart?.({ path: job })

    expect(reporter.getRows()).toEqual(['1 running / 0 queued / 0 cached / 0 warn / 0 error / 0 failed'])
  })

  it('renders no lines for a zero-row terminal and reserves both rows at height two', () => {
    const source = plan(1, '/repo/src/one.ts', 1)
    const job = path(source, 1, 'file', 'rule/a')
    const zeroRows = createReporter(0)
    const twoRows = createReporter(2)

    for (const reporter of [zeroRows, twoRows]) {
      reporter.onRunStart?.({ execution: counts({ planned: 1, queued: 1 }), plans: [source], rulesTotal: 1 })
      reporter.onPlanStart?.({ execution: counts({ planned: 1, running: 1 }), plan: source })
      reporter.onRuleStart?.({ path: job })
    }

    expect(zeroRows.getRows()).toEqual([])
    expect(twoRows.getRows()).toEqual([
      '',
      '1 running / 0 queued / 0 cached / 0 warn / 0 error / 0 failed',
    ])
  })

  it('removes only the ended job and settles a plan on its lifecycle event', () => {
    const reporter = createReporter()
    const source = plan(1, '/repo/src/one.ts', 2)
    const first = path(source, 1, 'file', 'rule/a')
    const second = path(source, 2, 'function', 'rule/b', 'f')

    reporter.onRunStart?.({ execution: counts({ planned: 2, queued: 2 }), plans: [source], rulesTotal: 2 })
    reporter.onPlanStart?.({ execution: counts({ planned: 2, queued: 1, running: 1 }), plan: source })
    reporter.onRuleStart?.({ path: first })
    reporter.onRuleStart?.({ path: second })
    reporter.onRuleEnd?.({ cache: 'miss', path: first, state: 'completed' })

    expect(reporter.getRows().join('\n')).not.toContain('rule/a')
    expect(reporter.getRows().join('\n')).toContain('rule/b')

    reporter.onRuleEnd?.({ cache: 'hit', path: second, state: 'cached' })
    reporter.onPlanEnd?.({ execution: counts({ cached: 1, completed: 1, planned: 2 }), plan: source })
    expect(reporter.getRows().join('\n')).not.toContain('src/one.ts')
  })

  it('keeps rows within configured columns and preserves semantic ANSI styling', () => {
    const reporter = createSummaryProgressReporter({
      color: false,
      columns: 42,
      cwd: '/repo',
      spinnerFrames: ['⠋'],
    })
    const source = plan(1, '/repo/packages/example/src/deep/file.ts', 1)
    const job = path(source, 1, 'function', '@alint-js/plugin-example/very-long-rule-name', 'load')

    reporter.onRunStart?.({ execution: counts({ planned: 1, queued: 1 }), plans: [source], rulesTotal: 1 })
    reporter.onPlanStart?.({ execution: counts({ planned: 1, running: 1 }), plan: source })
    reporter.onRuleStart?.({ path: job })
    reporter.onDiagnostic?.({
      diagnostic: { filePath: source.path, message: 'failure', ruleId: job.rule.id, severity: 'error' },
      diagnostics: [{ filePath: source.path, message: 'failure', ruleId: job.rule.id, severity: 'error' }],
      path: job,
    })

    const rows = reporter.getRows()
    expect(rows.every(row => fastStringWidth(row) <= 42)).toBe(true)
    expect(rows[0]).toContain('…')

    const colored = createSummaryProgressReporter({
      color: true,
      columns: 120,
      cwd: '/repo',
      spinnerFrames: ['⠋'],
    })
    colored.onRunStart?.({ execution: counts({ planned: 1, queued: 1 }), plans: [source], rulesTotal: 1 })
    colored.onPlanStart?.({ execution: counts({ planned: 1, running: 1 }), plan: source })
    colored.onRuleStart?.({ path: job })
    colored.onDiagnostic?.({
      diagnostic: { filePath: source.path, message: 'failure', ruleId: job.rule.id, severity: 'error' },
      diagnostics: [{ filePath: source.path, message: 'failure', ruleId: job.rule.id, severity: 'error' }],
      path: job,
    })
    expect(colored.getRows()[0]).toContain('\u001B[36m⠋')
    expect(colored.getRows().at(-1)).toContain('\u001B[31m1 error')
  })

  it('measures Chinese emoji and ANSI by terminal display width without splitting escapes or graphemes', () => {
    const reporter = createSummaryProgressReporter({
      color: false,
      columns: 32,
      cwd: '/repo',
      spinnerFrames: ['⠋'],
    })
    const source = plan(1, '/repo/中文目录😀😀😀😀😀/文件.ts', 1)
    const job = path(source, 1, 'function', '\u001B[31m规则😀😀😀😀😀😀😀😀\u001B[39m', '解析中文😀')

    reporter.onRunStart?.({ execution: counts({ planned: 1, queued: 1 }), plans: [source], rulesTotal: 1 })
    reporter.onPlanStart?.({ execution: counts({ planned: 1, running: 1 }), plan: source })
    reporter.onRuleStart?.({ path: job })

    const rows = reporter.getRows()
    expect(rows.every(row => fastStringWidth(row) <= 32)).toBe(true)
    expect(rows[1]).not.toMatch(/\u001B(?:\[[0-9;]*)?$/)
    expect(rows[1]).not.toMatch(/[\uD800-\uDBFF]$/)
    expect(rows[1]).toContain('\u001B[0m…')
  })

  it('truncates only a long plan label and permanently preserves the complete parent counter', () => {
    const reporter = createSummaryProgressReporter({
      color: false,
      columns: 24,
      cwd: '/repo',
      spinnerFrames: ['⠋'],
    })
    const source = plan(1, '/repo/very/long/中文😀/path/to/file.ts', 12)

    reporter.onRunStart?.({ execution: counts({ cached: 2, completed: 3, failed: 1, planned: 12, queued: 5, running: 1 }), plans: [source], rulesTotal: 1 })
    reporter.onPlanStart?.({ execution: counts({ cached: 2, completed: 3, failed: 1, planned: 12, queued: 5, running: 1 }), plan: source })

    const header = reporter.getRows()[0]!
    expect(header).toMatch(/3\/2\/1\/12$/)
    expect(fastStringWidth(header)).toBeLessThanOrEqual(24)
  })

  it('resets the spinner frame on run start', () => {
    const reporter = createReporter()
    const source = plan(1, '/repo/src/one.ts', 1)

    reporter.tick()
    reporter.onRunStart?.({ execution: counts({ planned: 1, queued: 1 }), plans: [source], rulesTotal: 1 })
    reporter.onPlanStart?.({ execution: counts({ planned: 1, running: 1 }), plan: source })

    expect(reporter.getRows()[0]?.startsWith('⠋ ')).toBe(true)
  })
})
