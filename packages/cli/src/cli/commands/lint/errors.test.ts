import type { AlintRunFailure, RunResult } from '@alint-js/core'

import { AlintProgressError, AlintRunCancelledError, AlintRunError } from '@alint-js/core'
import { describe, expect, it } from 'vitest'

import { formatCancelledError, formatRunError } from './errors'

const EMPTY_RESULT: RunResult = {
  diagnostics: [],
  execution: { cached: 0, cancelled: 0, completed: 0, failed: 0, planned: 0, queued: 0, running: 0, skipped: 0 },
  usage: { inputTokens: 0, outputTokens: 0, records: [], totalTokens: 0 },
}

function failure(
  index: number,
  kind: AlintRunFailure['kind'],
  planPath: string,
  targetKind: AlintRunFailure['path']['target']['kind'],
  ruleId: string,
  message: string,
  targetName?: string,
): AlintRunFailure {
  return {
    kind,
    message,
    path: {
      job: { index, total: 3 },
      plan: { id: `plan-${index}`, index, kind: targetKind === 'directory' ? 'directory' : targetKind === 'project' ? 'project' : 'source', path: planPath, planned: 1, total: 3 },
      rule: { id: ruleId, index: 0, total: 1 },
      target: { identity: `target-${index}`, index: 0, kind: targetKind, name: targetName, total: 1 },
    },
  }
}

describe('formatRunError', () => {
  const failures = [
    failure(0, 'handler', 'src/a.ts', 'function', 'rule/a', 'boom', 'parse'),
    failure(1, 'timeout', 'src/b.ts', 'file', 'rule/b', 'Rule execution timed out after 100ms.'),
    failure(2, 'cache-replay', '.', 'project', 'rule/c', 'invalid cached diagnostic'),
  ]

  it('formats every rule failure in planned order', () => {
    const error = new AlintRunError('3 rule executions failed', EMPTY_RESULT, { failures })

    expect(formatRunError(error, false)).toBe([
      'error 3 rule executions failed',
      '  [handler] src/a.ts > function parse > rule/a: boom',
      '  [timeout] src/b.ts > file > rule/b: Rule execution timed out after 100ms.',
      '  [cache-replay] . > project > rule/c: invalid cached diagnostic',
      '',
    ].join('\n'))
  })

  it('prints a progress infrastructure heading before attached rule failures', () => {
    const cause = new Error('terminal renderer crashed')
    const error = new AlintProgressError('Progress reporting failed.', EMPTY_RESULT, failures.slice(0, 1), cause)

    expect(formatRunError(error, false)).toBe([
      'error Progress reporting failed.',
      '  infrastructure: terminal renderer crashed',
      '  [handler] src/a.ts > function parse > rule/a: boom',
      '',
    ].join('\n'))
  })

  it.each([
    [undefined, 'undefined'],
    [null, 'null'],
    [0, '0'],
    [false, 'false'],
    ['', ''],
  ])('always formats infrastructure cause %j', (cause, expected) => {
    const error = new AlintProgressError('Progress reporting failed.', EMPTY_RESULT, [], cause)

    expect(formatRunError(error, false)).toBe([
      'error Progress reporting failed.',
      `  infrastructure: ${expected}`,
      '',
    ].join('\n'))
  })

  it('colors only the error label and prints each failure once', () => {
    const error = new AlintRunError('1 rule execution failed.', EMPTY_RESULT, { failures: failures.slice(0, 1) })
    const output = formatRunError(error, true)

    expect(output).toContain('\u001B[31merror\u001B[39m 1 rule execution failed.')
    expect(output.match(/\[handler\]/g)).toHaveLength(1)
    expect(output).toContain('src/a.ts > function parse > rule/a: boom')
  })
})

describe('formatCancelledError', () => {
  it('formats cancellation as an execution error', () => {
    expect(formatCancelledError(new AlintRunCancelledError(EMPTY_RESULT), false)).toBe('error Alint run cancelled.\n')
  })
})
