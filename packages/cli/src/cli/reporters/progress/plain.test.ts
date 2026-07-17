import type { ExecutionCounts, ProgressJob } from '@alint-js/core'

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

const JOB: ProgressJob = {
  id: 'job:1',
  index: 1,
  inputPath: 'src/input.ts',
  ruleId: 'company/require-title',
  ruleIndex: 1,
  ruleTotal: 1,
  target: { identity: 'function:loadConfig', kind: 'function', name: 'loadConfig' },
  total: 2,
}

describe('createPlainProgressReporter', () => {
  it('writes flat job paths and final exclusive execution counts without ANSI escapes', () => {
    const chunks: string[] = []
    const reporter = createPlainProgressReporter({ write: chunk => chunks.push(chunk) })

    reporter.onRunStart?.({ jobsTotal: 2 })
    reporter.onJobStart?.({ job: JOB })
    reporter.onRunEnd?.({
      diagnostics: [
        { filePath: JOB.inputPath, message: 'warned', ruleId: JOB.ruleId, severity: 'warn' },
        { filePath: JOB.inputPath, message: 'errored', ruleId: JOB.ruleId, severity: 'error' },
      ],
      execution: counts({ cached: 1, completed: 1, planned: 2 }),
      usage: { inputTokens: 10, outputTokens: 14, records: [], totalTokens: 24 },
    })

    expect(chunks.join('')).toBe([
      'alint started: 2 queued jobs',
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

    progress.reporter.onRunStart?.({ jobsTotal: 1 })
    progress.dispose()

    expect(chunks).toEqual(['alint started: 1 queued jobs\n'])
  })

  it('renders queued and started jobs through the TTY summary', () => {
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
    const current = { ...JOB, inputPath: '/repo/src/input.ts', ruleId: 'rule/current' }

    progress.reporter.onRunStart?.({ jobsTotal: 1 })
    progress.reporter.onJobQueued?.({ job: current })
    progress.reporter.onJobStart?.({ job: current })
    expect(progress.reporter.onJobRetry).toBeTypeOf('function')
    expect(() => progress.reporter.onJobRetry?.({ attempt: 1, job: current, maxAttempts: 3 })).not.toThrow()

    expect(chunks.join('\n')).toContain('⠋ rule/current 0/1 0% [░░░░░░░░░░] eta ? 1 running')
    expect(chunks.join('\n')).toContain('   └─ src/input.ts > function loadConfig 1/3 retrying elapsed 0.0s')
    expect(chunks.join('')).toContain('rule/current')
    progress.dispose()
    vi.useRealTimers()
  })
})
