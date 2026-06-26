import { describe, expect, it } from 'vitest'

import { createCliProgressReporter } from './index'
import { createPlainProgressReporter } from './plain'

describe('createPlainProgressReporter', () => {
  it('writes stable progress lines without ANSI escapes', () => {
    const chunks: string[] = []
    const reporter = createPlainProgressReporter({
      write: chunk => chunks.push(chunk),
    })

    reporter.onRunStart?.({
      filesTotal: 12,
      planned: 24,
      rulesTotal: 3,
    })
    reporter.onRuleStart?.({
      path: {
        file: { index: 1, path: 'src/input.ts', total: 12 },
        rule: { id: 'company/require-title', index: 2, total: 3 },
        target: { index: 1, kind: 'function', name: 'loadConfig', total: 2 },
      },
    })
    reporter.onRuleStart?.({
      path: {
        file: { index: 1, path: 'src/input.ts', total: 12 },
        rule: { id: 'company/no-file-todos', index: 1, total: 3 },
        target: { index: 2, kind: 'file', total: 2 },
      },
    })
    reporter.onRunEnd?.({
      cached: 0,
      completed: 24,
      diagnostics: [
        {
          filePath: 'src/input.ts',
          message: 'warned',
          ruleId: 'company/require-title',
          severity: 'warn',
        },
        {
          filePath: 'src/input.ts',
          message: 'errored',
          ruleId: 'company/no-file-todos',
          severity: 'error',
        },
      ],
      errored: 0,
      planned: 24,
      usage: {
        inputTokens: 10,
        outputTokens: 14,
        records: [],
        totalTokens: 24,
      },
    })

    const output = chunks.join('')

    expect(output).toBe([
      'alint started: 12 files, 3 rules, 24 planned executions',
      'scan src/input.ts > function loadConfig > company/require-title',
      'scan src/input.ts > file > company/no-file-todos',
      'alint finished: 1 warn, 1 error, 24 tokens',
      '',
    ].join('\n'))
    expect(output).not.toMatch(/\u001B\[[0-9;]*[a-z]/i)
  })

  it('marks the final line failed when executions errored', () => {
    const chunks: string[] = []
    const reporter = createPlainProgressReporter({
      write: chunk => chunks.push(chunk),
    })

    reporter.onRunEnd?.({
      cached: 0,
      completed: 0,
      diagnostics: [],
      errored: 1,
      planned: 1,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        records: [],
        totalTokens: 0,
      },
    })

    expect(chunks.join('')).toBe('alint failed: 0 warn, 0 error, 0 tokens, 1 errored\n')
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
      write: chunk => chunks.push(chunk),
    })

    progress.reporter.onRunStart?.({
      filesTotal: 1,
      planned: 1,
      rulesTotal: 1,
    })
    progress.dispose()

    expect(chunks).toEqual([
      'alint started: 1 files, 1 rules, 1 planned executions\n',
    ])
  })
})
