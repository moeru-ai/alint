import type { FileTarget, RuleContext } from '@alint-js/plugin'

import { describe, expect, it, vi } from 'vitest'

import { judgeSource } from '../../agents/judge/agent'
import { vacuousFunctionPrompt } from './prompt'
import { vacuousFunctionRule } from './rule'

vi.mock('../../agents/judge/agent', () => ({
  judgeSource: vi.fn(),
}))

const mockedJudgeSource = vi.mocked(judgeSource)
const SOURCE = 'export const normalize = (value: string) => value.trim()'

function createContext(overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    cwd: '/repo',
    id: 'js/no-vacuous-function',
    localId: 'no-vacuous-function',
    logger: { debug: () => {} },
    metering: { recordUsage: () => {} },
    model: async () => ({
      aliases: [],
      capabilities: [],
      id: 'review-model',
      name: 'Review model',
      params: {},
      provider: { endpoint: '', headers: {}, id: 'provider', type: 'openai-compatible' },
    }),
    options: [],
    report: () => {},
    settings: {},
    src: {
      getText: () => SOURCE,
      readFile: async filePath => ({ language: 'typescript', lines: [], path: filePath, text: '' }),
      sliceLines: (file, range) => ({
        filePath: file.path,
        loc: {
          end: { column: 0, line: range.endLine },
          start: { column: 0, line: range.startLine },
        },
        text: '',
      }),
      sliceRange: (file, range) => ({
        filePath: file.path,
        loc: {
          end: { column: range.end, line: 1 },
          start: { column: range.start, line: 1 },
        },
        text: '',
      }),
    },
    ...overrides,
  }
}

const target: FileTarget = {
  file: { language: 'typescript', lines: [SOURCE], path: '/repo/src/file.ts', text: SOURCE },
  identity: 'file:src/file.ts',
  kind: 'file',
  language: 'typescript',
  text: SOURCE,
}

describe('no-vacuous-function', () => {
  it('retains its cache key and local-only judge behavior even when an agent exists', async () => {
    mockedJudgeSource.mockResolvedValueOnce([{
      confidence: 'high',
      line: 1,
      message: 'normalize is a shallow trim wrapper.',
      suggestion: 'Inline value.trim().',
    }])
    const report = vi.fn()
    const agent = vi.fn()
    const context = createContext({ agent, report })

    await vacuousFunctionRule.create(context).onTargetFile?.(target)

    expect(vacuousFunctionRule.cacheKey).toBe(vacuousFunctionPrompt)
    expect(mockedJudgeSource).toHaveBeenCalledWith({
      logger: context.logger,
      metering: context.metering,
      model: await context.model(),
      operation: 'vacuous-function-judge',
      outputLanguage: undefined,
      prompt: vacuousFunctionPrompt,
      signal: undefined,
      source: SOURCE,
    })
    expect(agent).not.toHaveBeenCalled()
    expect(report).toHaveBeenCalledWith({
      evidence: { confidence: 'high', suggestion: 'Inline value.trim().' },
      filePath: '/repo/src/file.ts',
      loc: { start: { column: 0, line: 1 } },
      message: 'normalize is a shallow trim wrapper.',
    })
  })

  it('propagates local judge failures', async () => {
    mockedJudgeSource.mockRejectedValueOnce(new Error('judge unavailable'))

    await expect(vacuousFunctionRule.create(createContext()).onTargetFile?.(target))
      .rejects
      .toThrow('judge unavailable')
  })
})
