import { describe, expect, it } from 'vitest'

import { createSummaryProgressReporter } from './summary'

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-9;]*m/g, '')
}

describe('createSummaryProgressReporter', () => {
  it('renders active files nested rule rows queued files and footer estimates', () => {
    const reporter = createSummaryProgressReporter({
      clock: () => 6000,
      color: false,
      columns: 120,
      cwd: '/repo',
      spinnerFrames: ['⠋', '⠙'],
    })
    const firstPath = {
      file: { index: 1, path: '/repo/src/setup/toml.ts', planned: 1, total: 3 },
      rule: { id: '@alint-js/plugin-example/inline-miniature-normalizer', index: 1, total: 1 },
      target: { index: 1, kind: 'file' as const, total: 1 },
    }
    const secondPath = {
      file: { index: 2, path: '/repo/src/config/file-2.ts', planned: 1, total: 3 },
      rule: { id: '@alint-js/plugin-example/inline-miniature-normalizer', index: 1, total: 1 },
      target: { index: 1, kind: 'function' as const, name: 'load', total: 1 },
    }

    reporter.onRunStart?.({
      files: [
        firstPath.file,
        secondPath.file,
        { index: 3, path: '/repo/src/config/file-3.ts', planned: 1, total: 3 },
      ],
      filesTotal: 3,
      planned: 3,
      rulesTotal: 1,
      startedAt: 0,
    })
    reporter.tick()
    reporter.onFileStart?.({ file: firstPath.file, startedAt: 1800 })
    reporter.onTargetStart?.({ path: firstPath, startedAt: 1800 })
    reporter.onRuleStart?.({ path: firstPath, startedAt: 1800 })
    reporter.onFileStart?.({ file: secondPath.file, startedAt: 4200 })
    reporter.onTargetStart?.({ path: secondPath, startedAt: 4200 })
    reporter.onRuleStart?.({ path: secondPath, startedAt: 4200 })

    const rows = reporter.getRows()

    expect(rows[0]).toMatch(/^⠙ src\/setup\/toml\.ts\s+0\/0\/0\/1$/)
    expect(rows[1]).toBe('    file > @alint-js/plugin-example/inline-miniature-normalizer (4.2s, ~?)')
    expect(rows[2]).toMatch(/^⠙ src\/config\/file-2\.ts\s+0\/0\/0\/1$/)
    expect(rows[3]).toBe('    function load > @alint-js/plugin-example/inline-miniature-normalizer (1.8s, ~?)')
    expect(rows[4]).toBe('  1 file queued')
    expect(rows[5]).toBe('')
    expect(rows[6]).toBe('6.0s -> ~? | 0 tokens -> ~? tokens | 1 queued / 0 cached / 0 warn / 0 error')
  })

  it('updates completed warning and token totals in the footer', () => {
    const reporter = createSummaryProgressReporter({
      clock: () => 6000,
      color: false,
      columns: 120,
      cwd: '/repo',
      spinnerFrames: ['⠋'],
    })
    const path = {
      file: { index: 1, path: '/repo/src/setup/toml.ts', planned: 3, total: 1 },
      rule: { id: 'company/problem', index: 1, total: 1 },
      target: { index: 1, kind: 'file' as const, total: 1 },
    }

    reporter.onRunStart?.({
      files: [path.file],
      filesTotal: 1,
      planned: 3,
      rulesTotal: 1,
      startedAt: 0,
    })
    reporter.onFileStart?.({ file: path.file, startedAt: 0 })
    reporter.onRuleStart?.({ path, startedAt: 1000 })
    reporter.onDiagnostic?.({
      diagnostic: {
        filePath: path.file.path,
        message: 'Problem found',
        ruleId: 'company/problem',
        severity: 'warn',
      },
      diagnostics: [
        {
          filePath: path.file.path,
          message: 'Problem found',
          ruleId: 'company/problem',
          severity: 'warn',
        },
      ],
      path,
    })
    reporter.onRuleEnd?.({
      cache: 'miss',
      endedAt: 2000,
      path,
      startedAt: 1000,
      state: 'completed',
    })
    reporter.onUsage?.({
      path,
      record: {
        inputTokens: 10,
        modelId: 'local',
        outputTokens: 2,
        providerId: 'provider',
        ruleId: 'company/problem',
        totalTokens: 12,
      },
      total: {
        inputTokens: 10,
        outputTokens: 2,
        records: [],
        totalTokens: 12,
      },
    })

    expect(reporter.getRows().at(-1)).toBe('6.0s -> ~18.0s | 12 tokens -> ~36 tokens | 0 queued / 0 cached / 1 warn / 0 error')
  })

  it('clears active nested rows when rule target and file end', () => {
    const reporter = createSummaryProgressReporter({
      clock: () => 1000,
      color: false,
      columns: 100,
      cwd: '/repo',
      spinnerFrames: ['⠋'],
    })
    const path = {
      file: { index: 1, path: '/repo/src/setup/toml.ts', planned: 1, total: 1 },
      rule: { id: 'company/problem', index: 1, total: 1 },
      target: { index: 1, kind: 'function' as const, name: 'load', total: 1 },
    }

    reporter.onRunStart?.({ files: [path.file], filesTotal: 1, planned: 1, rulesTotal: 1, startedAt: 0 })
    reporter.onFileStart?.({ file: path.file, startedAt: 0 })
    reporter.onTargetStart?.({ path, startedAt: 0 })
    reporter.onRuleStart?.({ path, startedAt: 0 })
    expect(reporter.getRows()[1]).toContain('function load > company/problem')

    reporter.onRuleEnd?.({ cache: 'miss', path, state: 'completed' })
    expect(reporter.getRows().join('\n')).not.toContain('company/problem')

    reporter.onTargetEnd?.({ path })
    reporter.onFileEnd?.({ file: path.file })
    expect(reporter.getRows()[0]).toMatch(/^⠋ alint\s+1\/0\/0\/1$/)
  })

  it('keeps rows within configured columns and truncates with ellipsis', () => {
    const reporter = createSummaryProgressReporter({
      clock: () => 6000,
      color: false,
      columns: 42,
      cwd: '/repo',
      spinnerFrames: ['⠋'],
    })
    const path = {
      file: { index: 1, path: '/repo/packages/example/src/deep/file.ts', planned: 1, total: 1 },
      rule: { id: '@alint-js/plugin-example/very-long-rule-name', index: 1, total: 1 },
      target: { index: 1, kind: 'function' as const, name: 'load', total: 1 },
    }

    reporter.onRunStart?.({ files: [path.file], filesTotal: 1, planned: 1, rulesTotal: 1, startedAt: 0 })
    reporter.onFileStart?.({ file: path.file, startedAt: 0 })
    reporter.onRuleStart?.({ path, startedAt: 0 })

    const rows = reporter.getRows()

    expect(rows[0].length).toBeLessThanOrEqual(42)
    expect(rows[0]).toContain('…')
    expect(rows[1].length).toBeLessThanOrEqual(42)
    expect(rows[1]).toContain('…')
  })

  it('colors progress rows by semantic segment instead of tinting the whole row', () => {
    const reporter = createSummaryProgressReporter({
      clock: () => 6000,
      color: true,
      columns: 120,
      cwd: '/repo',
      spinnerFrames: ['⠋'],
    })
    const path = {
      file: { index: 1, path: '/repo/src/setup/toml.ts', planned: 1, total: 1 },
      rule: { id: '@alint-js/plugin-example/inline-miniature-normalizer', index: 1, total: 1 },
      target: { index: 1, kind: 'file' as const, total: 1 },
    }

    reporter.onRunStart?.({ files: [path.file], filesTotal: 1, planned: 1, rulesTotal: 1, startedAt: 0 })
    reporter.onFileStart?.({ file: path.file, startedAt: 0 })
    reporter.onTargetStart?.({ path, startedAt: 0 })
    reporter.onRuleStart?.({ path, startedAt: 0 })
    reporter.onRuleEnd?.({ cache: 'miss', path, state: 'errored' })
    reporter.onDiagnostic?.({
      diagnostic: {
        filePath: path.file.path,
        message: 'Failure found',
        ruleId: 'company/problem',
        severity: 'error',
      },
      diagnostics: [
        {
          filePath: path.file.path,
          message: 'Problem found',
          ruleId: 'company/problem',
          severity: 'warn',
        },
        {
          filePath: path.file.path,
          message: 'Failure found',
          ruleId: 'company/problem',
          severity: 'error',
        },
      ],
      path,
    })
    reporter.onUsage?.({
      record: {
        inputTokens: 0,
        modelId: 'local',
        outputTokens: 0,
        providerId: 'provider',
        ruleId: 'company/problem',
        totalTokens: 42,
      },
      total: {
        inputTokens: 0,
        outputTokens: 0,
        records: [],
        totalTokens: 42,
      },
    })

    const rows = reporter.getRows()
    const firstRow = rows[0]!
    const footer = rows.at(-1)!

    expect(stripAnsi(firstRow)).toContain('src/setup/toml.ts')
    expect(firstRow).toContain('\u001B[36m⠋')
    expect(firstRow).toContain('\u001B[31m0/0/1/1')
    expect(footer).toContain('\u001B[33m1 warn')
    expect(footer).toContain('\u001B[31m1 error')
    expect(footer).toContain('\u001B[36m42 tokens')
  })

  it('resets the spinner frame on run start', () => {
    const reporter = createSummaryProgressReporter({
      color: false,
      columns: 80,
      cwd: '/repo',
      spinnerFrames: ['⠋', '⠙'],
    })

    reporter.tick()
    reporter.onRunStart?.({ filesTotal: 1, planned: 1, rulesTotal: 1 })

    expect(reporter.getRows()[0].startsWith('⠋ ')).toBe(true)
  })
})
