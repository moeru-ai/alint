import type { Diagnostic, RunResult } from '../../core/types'

import { describe, expect, it } from 'vitest'

import { formatDiagnostics } from './index'
import { formatJson } from './json'
import { formatStylish } from './stylish'

function createDiagnostics(): Diagnostic[] {
  return [
    {
      filePath: 'src/a.ts',
      loc: {
        start: {
          column: 0,
          line: 2,
        },
      },
      message: 'Problem found',
      ruleId: 'local/demo',
      severity: 'warn',
    },
    {
      filePath: 'src/a.ts',
      loc: {
        start: {
          column: 4,
          line: 8,
        },
      },
      message: 'Another problem',
      ruleId: 'local/second',
      severity: 'error',
    },
    {
      filePath: 'src/b.ts',
      message: 'Missing location',
      ruleId: 'local/third',
      severity: 'warn',
    },
  ]
}

function createResult(): RunResult {
  return {
    diagnostics: createDiagnostics(),
    usage: {
      inputTokens: 12,
      outputTokens: 5,
      records: [
        {
          inputTokens: 12,
          modelId: 'local:qwen-8b',
          outputTokens: 5,
          providerId: 'ollama',
          ruleId: 'local/demo',
          totalTokens: 17,
        },
      ],
      totalTokens: 17,
    },
  }
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-9;]*m/g, '')
}

describe('reporters', () => {
  it('formatJson returns pretty JSON with diagnostics and trailing newline', () => {
    expect(formatJson(createResult())).toBe(`${JSON.stringify(createResult(), null, 2)}\n`)
  })

  it('formatStylish groups diagnostics by file and includes location severity message and rule id', () => {
    expect(formatStylish(createDiagnostics())).toBe([
      'src/a.ts',
      '  2:0  warning  Problem found  local/demo',
      '  8:4  error  Another problem  local/second',
      '',
      'src/b.ts',
      '  0:0  warning  Missing location  local/third',
      '',
      '',
      '2 warn / 1 error',
      '',
    ].join('\n'))
  })

  it('formatStylish includes a token summary when given a run result', () => {
    expect(formatStylish(createResult())).toBe([
      'src/a.ts',
      '  2:0  warning  Problem found  local/demo',
      '  8:4  error  Another problem  local/second',
      '',
      'src/b.ts',
      '  0:0  warning  Missing location  local/third',
      '',
      '',
      '2 warn / 1 error | 17 tokens',
      '',
    ].join('\n'))
  })

  it('formatStylish colors severity file location and rule id when enabled', () => {
    const output = formatStylish(createDiagnostics(), { color: true })

    expect(stripAnsi(output)).toBe(formatStylish(createDiagnostics()))
    expect(output).toContain('\u001B[4m')
    expect(output).toContain('\u001B[2m')
    expect(output).toContain('\u001B[33mwarning')
    expect(output).toContain('\u001B[31merror')
  })

  it('formatStylish colors summary segments when enabled', () => {
    const output = formatStylish(createResult(), { color: true })

    expect(stripAnsi(output)).toBe(formatStylish(createResult()))
    expect(output).toContain('\u001B[33m2 warn')
    expect(output).toContain('\u001B[31m1 error')
    expect(output).toContain('\u001B[36m17 tokens')
  })

  it('formatStylish returns empty string when there are no diagnostics', () => {
    expect(formatStylish([])).toBe('')
  })

  it('formatDiagnostics delegates to json and stylish reporters', () => {
    const diagnostics = createDiagnostics()

    expect(formatDiagnostics('json', createResult())).toBe(formatJson(createResult()))
    expect(formatDiagnostics('stylish', createResult())).toBe(formatStylish(createResult()))
    expect(formatDiagnostics('stylish', createResult(), { color: true })).toBe(formatStylish(createResult(), { color: true }))
    expect(formatStylish(diagnostics)).toContain('2 warn / 1 error')
  })

  it('formatDiagnostics rejects unknown reporter names at runtime', () => {
    expect(() => formatDiagnostics('unknown' as never, createResult())).toThrow('Unknown reporter "unknown".')
  })
})
