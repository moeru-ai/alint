import type { ExecutionCounts } from '@alint-js/core'

import { describe, expect, it, vi } from 'vitest'

import { createCliProgressReporter } from './index'
import { createPlainProgressReporter } from './plain'

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

describe('createPlainProgressReporter', () => {
  it('writes plan paths and final exclusive execution counts without ANSI escapes', () => {
    const chunks: string[] = []
    const reporter = createPlainProgressReporter({ write: chunk => chunks.push(chunk) })
    const plan = { id: 'source:1', index: 1, kind: 'source' as const, path: 'src/input.ts', planned: 2, total: 1 }

    reporter.onRunStart?.({ execution: counts({ planned: 2, queued: 2 }), plans: [plan], rulesTotal: 2 })
    reporter.onRuleStart?.({
      path: {
        job: { index: 1, total: 2 },
        plan,
        rule: { id: 'company/require-title', index: 1, total: 2 },
        target: { identity: 'function:loadConfig', index: 1, kind: 'function', name: 'loadConfig', total: 2 },
      },
    })
    reporter.onRunEnd?.({
      diagnostics: [
        { filePath: plan.path, message: 'warned', ruleId: 'company/require-title', severity: 'warn' },
        { filePath: plan.path, message: 'errored', ruleId: 'company/require-title', severity: 'error' },
      ],
      execution: counts({ cached: 1, completed: 1, planned: 2 }),
      usage: { inputTokens: 10, outputTokens: 14, records: [], totalTokens: 24 },
    })

    expect(chunks.join('')).toBe([
      'alint started: 1 plans, 2 rules, 2 planned executions',
      'scan src/input.ts > function loadConfig > company/require-title',
      'alint finished: 1 warn, 1 error, 24 tokens, 1 completed, 1 cached, 0 failed, 0 cancelled, 0 skipped',
      '',
    ].join('\n'))
    expect(chunks.join('')).not.toMatch(/\u001B\[[0-9;]*[a-z]/i)
  })

  it('marks the final line failed from the final failed count', () => {
    const chunks: string[] = []
    const reporter = createPlainProgressReporter({ write: chunk => chunks.push(chunk) })

    reporter.onRunEnd?.({
      diagnostics: [],
      execution: counts({ cancelled: 1, failed: 1, planned: 2 }),
      usage: { inputTokens: 0, outputTokens: 0, records: [], totalTokens: 0 },
    })

    expect(chunks.join('')).toBe('alint failed: 0 warn, 0 error, 0 tokens, 0 completed, 0 cached, 1 failed, 1 cancelled, 0 skipped\n')
  })
})

describe('createCliProgressReporter', () => {
  it('returns the plain reporter with noop dispose for non-TTY output', () => {
    const chunks: string[] = []
    const progress = createCliProgressReporter({
      color: true,
      columns: 80,
      cwd: '/repo',
      isTty: false,
      rows: 12,
      write: chunk => chunks.push(chunk),
    })

    progress.reporter.onRunStart?.({ execution: counts({ planned: 1, queued: 1 }), plans: [], rulesTotal: 1 })
    progress.dispose()

    expect(chunks).toEqual(['alint started: 0 plans, 1 rules, 1 planned executions\n'])
  })

  it('forwards plan lifecycle events to the rendering summary', () => {
    vi.useFakeTimers()
    const chunks: string[] = []
    const progress = createCliProgressReporter({
      color: false,
      columns: 80,
      cwd: '/repo',
      isTty: true,
      rows: 10,
      write: chunk => chunks.push(chunk),
    })
    const plan = { id: 'project:1', index: 1, kind: 'project' as const, path: '/repo', planned: 1, total: 1 }

    progress.reporter.onRunStart?.({ execution: counts({ planned: 1, queued: 1 }), plans: [plan], rulesTotal: 1 })
    progress.reporter.onPlanStart?.({ execution: counts({ planned: 1, running: 1 }), plan })

    expect(chunks.join('\n')).toContain('⠋ .')
    progress.dispose()
    vi.useRealTimers()
  })
})
