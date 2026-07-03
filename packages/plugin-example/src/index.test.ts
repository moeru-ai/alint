import type { RuleContext, SourceTarget } from '@alint-js/core'

import { describe, expect, it } from 'vitest'

import * as v from 'valibot'

import { createJudgeMessages, createReportFindingsToolParameters, examplePlugin, inlineMiniatureNormalizerPrompt, judgeFindingSchema, judgeResponseSchema } from './index'

function createRuleContext(): RuleContext {
  return {
    cwd: '/repo',
    id: 'example/inline-miniature-normalizer',
    localId: 'inline-miniature-normalizer',
    logger: {
      debug: () => {},
    },
    metering: {
      recordUsage: () => {},
    },
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
    report: () => {},
    settings: {
      profile: 'docs',
    },
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
}

function createSourceTarget(kind: SourceTarget['kind']): SourceTarget {
  const file = {
    language: 'text/plain',
    lines: ['function load() {}'],
    path: '/repo/demo.txt',
    text: 'function load() {}',
  }

  return {
    file,
    identity: `${kind}:demo`,
    kind,
    language: file.language,
    text: file.text,
  }
}

function getInlineMiniatureNormalizerRule() {
  const rule = examplePlugin.rules?.['inline-miniature-normalizer']

  if (!rule) {
    throw new Error('Expected example plugin to expose inline-miniature-normalizer rule')
  }

  return rule
}

describe('examplePlugin', () => {
  it('uses flat plugin shape with a recommended config alias', () => {
    expect('scope' in examplePlugin).toBe(false)
    expect(examplePlugin.configs?.recommended).toEqual([
      {
        rules: {
          'example/inline-miniature-normalizer': 'warn',
        },
      },
    ])
  })

  it('exposes the inline-miniature-normalizer rule through onTarget only', () => {
    const handlers = getInlineMiniatureNormalizerRule().create(createRuleContext())

    expect(handlers.onTarget).toBeTypeOf('function')
    expect('onFile' in handlers).toBe(false)
    expect('onFunction' in handlers).toBe(false)
    expect('onClass' in handlers).toBe(false)
  })

  it('ignores non-file SourceTargets before requesting a model', async () => {
    const context = createRuleContext()
    let modelRequests = 0
    context.model = async () => {
      modelRequests += 1
      throw new Error('Model should not be requested for non-file targets')
    }

    await getInlineMiniatureNormalizerRule().create(context).onTarget?.(createSourceTarget('function'))

    expect(modelRequests).toBe(0)
    expect(context.settings).toEqual({ profile: 'docs' })
  })
})

describe('createJudgeMessages', () => {
  it('sends source code to the judge with stable line numbers', () => {
    const messages = createJudgeMessages('alpha\nbeta\n', undefined)

    expect(messages.at(-1)?.content).toContain([
      'Code with line numbers:',
      '',
      '1 | alpha',
      '2 | beta',
      '3 | ',
    ].join('\n'))
  })

  it('instructs the judge to report both tiny leaf helpers and normalizer orchestrators', () => {
    expect(inlineMiniatureNormalizerPrompt).toContain('Report tiny leaf helpers')
    expect(inlineMiniatureNormalizerPrompt).toContain('Report orchestration functions')
  })

  it('keeps structured output formatting rules out of the prompt', () => {
    expect(inlineMiniatureNormalizerPrompt).not.toContain('Return JSON only')
    expect(inlineMiniatureNormalizerPrompt).not.toContain('Do not wrap the JSON in Markdown fences')
  })

  it('stores finding output requirements in schema descriptions', () => {
    expect(v.getDescription(judgeResponseSchema.entries.findings)).toContain('empty array')
    expect(v.getDescription(judgeFindingSchema.pipe[0].entries.line)).toContain('function declaration line')
    expect(v.getDescription(judgeFindingSchema.pipe[0].entries.message)).toContain('specific helper function')
    expect(v.getDescription(judgeFindingSchema.pipe[0].entries.suggestion)).toContain('under 35 words')
  })

  it('normalizes nested tool object schemas for strict function calling', () => {
    const parameters = createReportFindingsToolParameters()
    const findings = parameters.properties?.findings

    expect(parameters.additionalProperties).toBe(false)
    expect(typeof findings).toBe('object')

    if (typeof findings === 'object' && !Array.isArray(findings.items) && typeof findings.items === 'object') {
      expect(findings.items.additionalProperties).toBe(false)
    }
    else {
      throw new TypeError('Expected findings.items to be an object schema')
    }
  })
})
