import { describe, expect, it } from 'vitest'

import * as v from 'valibot'

import { createJudgeMessages, createReportFindingsToolParameters, inlineMiniatureNormalizerPrompt, judgeFindingSchema, judgeResponseSchema } from './index'

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
