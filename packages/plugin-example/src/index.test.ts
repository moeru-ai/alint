import type { RuleContext, SourceTarget } from '@alint-js/core'

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { getDescription } from 'valibot'
import { describe, expect, it } from 'vitest'

import { createJudgeMessages, createReportFindingsToolParameters, judgeFindingSchema, judgeResponseSchema } from './agents/judge'
import { examplePlugin } from './index'
import { inlineMiniatureNormalizerPrompt } from './rules/inline-miniature-normalizer/prompt'
import { redundantJsdocPrompt } from './rules/no-redundant-jsdoc/prompt'
import { trivialWrapperStackPrompt } from './rules/no-trivial-wrapper-stack/prompt'

const fixtureDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures')

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

function getRule(localId: string) {
  const rule = examplePlugin.rules?.[localId]

  if (!rule) {
    throw new Error(`Expected example plugin to expose ${localId} rule`)
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
          'example/no-redundant-jsdoc': 'warn',
          'example/no-trivial-wrapper-stack': 'warn',
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

  it('exposes the wrapper stack and redundant JSDoc rules through onTarget only', () => {
    for (const localId of ['no-trivial-wrapper-stack', 'no-redundant-jsdoc']) {
      const handlers = getRule(localId).create(createRuleContext())

      expect(handlers.onTarget).toBeTypeOf('function')
      expect('onFile' in handlers).toBe(false)
      expect('onFunction' in handlers).toBe(false)
      expect('onClass' in handlers).toBe(false)
    }
  })

  it('ignores non-file SourceTargets for wrapper stack and redundant JSDoc rules before requesting a model', async () => {
    for (const localId of ['no-trivial-wrapper-stack', 'no-redundant-jsdoc']) {
      const context = createRuleContext()
      let modelRequests = 0
      context.model = async () => {
        modelRequests += 1
        throw new Error(`Model should not be requested for ${localId} non-file targets`)
      }

      await getRule(localId).create(context).onTarget?.(createSourceTarget('function'))

      expect(modelRequests).toBe(0)
    }
  })
})

describe('createJudgeMessages', () => {
  it('sends source code to the judge with stable line numbers', () => {
    const messages = createJudgeMessages('alpha\nbeta\n', undefined, undefined, inlineMiniatureNormalizerPrompt)

    expect(messages.at(-1)?.content).toContain([
      'Code with line numbers:',
      '',
      '1 | alpha',
      '2 | beta',
      '3 | ',
    ].join('\n'))
  })

  it('includes output language instructions when provided', () => {
    const messages = createJudgeMessages('alpha\n', undefined, '繁體中文', inlineMiniatureNormalizerPrompt)

    expect(messages.at(-1)?.content).toContain('Write all human-readable finding messages and suggestions in this language: 繁體中文.')
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
    expect(getDescription(judgeResponseSchema.entries.findings)).toContain('current rule')
    expect(getDescription(judgeFindingSchema.pipe[0].entries.line)).toContain('specific symbol')
    expect(getDescription(judgeFindingSchema.pipe[0].entries.message)).toContain('rule-specific')
    expect(getDescription(judgeFindingSchema.pipe[0].entries.suggestion)).toContain('under 35 words')
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

describe('no-trivial-wrapper-stack prompt', () => {
  it('focuses on wrapper chains without judging documentation volume', () => {
    expect(trivialWrapperStackPrompt).toContain('shallow wrapper chain')
    expect(trivialWrapperStackPrompt).toContain('parameter forwarding')
    expect(trivialWrapperStackPrompt).toContain('Do not report wrappers that add a real boundary')
    expect(trivialWrapperStackPrompt).not.toContain('JSDoc')
    expect(trivialWrapperStackPrompt).not.toContain('documentation')
  })
})

describe('judge agent boundary', () => {
  it('keeps model resolution explicit in rules instead of inside the judge agent', () => {
    const agent = readFileSync(join(fixtureDirectory, '../../src/agents/judge/agent.ts'), 'utf8')
    const inlineRule = readFileSync(join(fixtureDirectory, '../../src/rules/inline-miniature-normalizer/rule.ts'), 'utf8')
    const redundantRule = readFileSync(join(fixtureDirectory, '../../src/rules/no-redundant-jsdoc/rule.ts'), 'utf8')
    const wrapperRule = readFileSync(join(fixtureDirectory, '../../src/rules/no-trivial-wrapper-stack/rule.ts'), 'utf8')

    expect(agent).not.toContain('ctx.model')
    expect(inlineRule).toContain('const model = await ctx.model()')
    expect(redundantRule).toContain('const model = await ctx.model()')
    expect(wrapperRule).toContain('const model = await ctx.model()')
  })
})

describe('no-redundant-jsdoc prompt', () => {
  it('focuses on redundant comments while preserving non-obvious runtime rationale', () => {
    expect(redundantJsdocPrompt).toContain('redundant JSDoc')
    expect(redundantJsdocPrompt).toContain('restates the function name, signature, or body')
    expect(redundantJsdocPrompt).toContain('Do not report comments that explain non-obvious runtime behavior')
    expect(redundantJsdocPrompt).toContain('retry')
    expect(redundantJsdocPrompt).not.toContain('wrapper chain')
  })

  it('stores the motivating sample as a business-neutral fixture', () => {
    const fixture = readFileSync(join(fixtureDirectory, 'trivial-wrapper-stack/source.ts.txt'), 'utf8')

    expect(fixture).toContain('assertFeatureContextAllowed')
    expect(fixture).toContain('resolveFeatureRunGuard')
    expect(fixture).not.toContain('memory')
    expect(fixture).not.toContain('workflow')
    expect(fixture).not.toContain('Redis')
    expect(fixture).not.toContain('Upstash')
  })
})
