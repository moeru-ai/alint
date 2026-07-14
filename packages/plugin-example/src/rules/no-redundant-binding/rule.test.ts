import type { FileTarget, RuleContext } from '@alint-js/core'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { judgeSource } from '../../agents/judge/agent'
import { redundantBindingRule } from './rule'
import { verifyRedundantBindings } from './verifier'

vi.mock('../../agents/judge/agent', () => ({
  judgeSource: vi.fn(),
}))
vi.mock('./verifier', () => ({
  verifyRedundantBindings: vi.fn(),
}))

const mockedJudgeSource = vi.mocked(judgeSource)
const mockedVerifyRedundantBindings = vi.mocked(verifyRedundantBindings)

function createContext() {
  const diagnostics: Parameters<RuleContext['report']>[0][] = []
  const context: RuleContext = {
    cwd: '/repo',
    id: 'example/no-redundant-binding',
    localId: 'no-redundant-binding',
    logger: { debug: () => {} },
    metering: { recordUsage: () => {} },
    model: async () => ({
      aliases: [],
      capabilities: ['tool-call'],
      id: 'model',
      name: 'model',
      params: {},
      provider: {
        endpoint: 'http://localhost:11434/v1',
        headers: {},
        id: 'provider',
        type: 'openai-compatible',
      },
    }),
    report: diagnostic => diagnostics.push(diagnostic),
    settings: {},
    src: {
      getText: target => target.text,
      readFile: async filePath => ({
        language: 'text/plain',
        lines: [''],
        path: filePath,
        text: '',
      }),
      sliceLines: (file, range) => ({
        filePath: file.path,
        loc: {
          end: { column: 0, line: range.endLine },
          start: { column: 0, line: range.startLine },
        },
        text: file.lines.slice(range.startLine - 1, range.endLine).join('\n'),
      }),
      sliceRange: (file, range) => ({
        filePath: file.path,
        loc: {
          end: { column: range.end, line: 1 },
          start: { column: range.start, line: 1 },
        },
        text: file.text.slice(range.start, range.end),
      }),
    },
  }

  return { context, diagnostics }
}

function createFileTarget(): FileTarget {
  const text = [
    'function review(first: object, second: object) {',
    '  const left = first',
    '  consume(left)',
    '  const right = second',
    '  consume(right)',
    '}',
  ].join('\n')
  const file = {
    language: 'text/plain',
    lines: text.split('\n'),
    path: '/repo/source.ts',
    text,
  }

  return {
    file,
    identity: 'file:source.ts',
    kind: 'file',
    language: file.language,
    text,
  }
}

describe('redundantBindingRule', () => {
  beforeEach(() => {
    mockedJudgeSource.mockReset()
    mockedVerifyRedundantBindings.mockReset()
  })

  it('stops after discovery when there are no candidates', async () => {
    mockedJudgeSource.mockResolvedValueOnce([])
    const { context, diagnostics } = createContext()

    await redundantBindingRule.create(context).onTargetFile?.(createFileTarget())

    expect(mockedJudgeSource).toHaveBeenCalledTimes(1)
    expect(mockedVerifyRedundantBindings).not.toHaveBeenCalled()
    expect(mockedJudgeSource.mock.calls[0]?.[0].operation).toBe('redundant-binding-discovery')
    expect(diagnostics).toEqual([])
  })

  it('allows discovered lines, preserves separate declarations, and reports each line once', async () => {
    mockedJudgeSource.mockResolvedValueOnce([
      { confidence: 'high', line: 2, message: 'candidate left', suggestion: 'verify left' },
      { confidence: 'high', line: 4, message: 'candidate right', suggestion: 'verify right' },
    ])
    mockedVerifyRedundantBindings.mockResolvedValueOnce([
      { confidence: 'high', line: 2, message: 'left is redundant', suggestion: 'Use the source directly.' },
      { confidence: 'medium', line: 2, message: 'duplicate left', suggestion: 'Use the source directly.' },
      { confidence: 'medium', line: 4, message: 'right is redundant', suggestion: 'Use the source directly.' },
      { confidence: 'high', line: 99, message: 'not discovered', suggestion: 'Ignore this.' },
    ])
    const { context, diagnostics } = createContext()

    await redundantBindingRule.create(context).onTargetFile?.(createFileTarget())

    expect(mockedJudgeSource).toHaveBeenCalledTimes(1)
    expect(mockedVerifyRedundantBindings).toHaveBeenCalledTimes(1)
    expect(mockedVerifyRedundantBindings.mock.calls[0]?.[0]).toMatchObject({
      candidates: [
        { line: 2, message: 'candidate left' },
        { line: 4, message: 'candidate right' },
      ],
      source: createFileTarget().text,
    })
    expect(diagnostics).toEqual([
      {
        evidence: {
          confidence: 'high',
          suggestion: 'Use the source directly.',
        },
        filePath: '/repo/source.ts',
        loc: { start: { column: 0, line: 2 } },
        message: 'left is redundant',
      },
      {
        evidence: {
          confidence: 'medium',
          suggestion: 'Use the source directly.',
        },
        filePath: '/repo/source.ts',
        loc: { start: { column: 0, line: 4 } },
        message: 'right is redundant',
      },
    ])
  })
})
