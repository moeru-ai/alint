import type { RuleContext } from '@alint-js/plugin'

import { getDescription, safeParse } from 'valibot'
import { describe, expect, it } from 'vitest'

import { mixedLayersWithoutAbstractionPrompt } from './prompt'
import {
  createMixedLayerMessages,
  createMixedLayerToolParameters,
  mixedLayerFindingSchema,
  mixedLayerResponseSchema,
  mixedLayersWithoutAbstractionRule,
  normalizeMixedLayerFindings,
  reportMixedLayerFindings,
} from './rule'

function createReportContext() {
  const diagnostics: Parameters<RuleContext['report']>[0][] = []
  const context: Pick<RuleContext, 'report'> = {
    report: diagnostic => diagnostics.push(diagnostic),
  }

  return { context, diagnostics }
}

function createRuleContext(): RuleContext {
  return {
    cwd: '/repo',
    id: 'example/no-mixed-layers-without-abstraction',
    localId: 'no-mixed-layers-without-abstraction',
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
    report: () => {},
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
}

function finding(overrides: Partial<Parameters<typeof normalizeMixedLayerFindings>[0][number]> = {}) {
  return {
    boundaryKind: 'data-adaptation' as const,
    confidence: 'high' as const,
    declaration: 'interpretFrame',
    line: 2,
    message: 'interpretFrame makes a reusable external response contract inside the consumer.',
    relatedDeclarations: [
      {
        line: 1,
        name: 'readFrame',
        relationship: 'Move with interpretFrame behind the same external integration interface.',
      },
    ],
    suggestion: 'Move readFrame and interpretFrame into a focused integration owner and expose interpreted frames.',
    ...overrides,
  }
}

describe('mixedLayersWithoutAbstractionPrompt', () => {
  it('defines reusable integration boundaries without motivating trigger terms', () => {
    expect(mixedLayersWithoutAbstractionPrompt).toContain('external capability')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('stable abstraction')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('relatedDeclarations')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('does not earn an abstraction')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('Do not require a fixed number of layers')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('at least two responsibilities')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('at least two responsibilities in that integration can change or be reused independently')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('embedded in a consuming feature')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('the consumer understands lower-level request, response, failure, or protocol details')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('report every primary declaration')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('a focused integration module')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('a simple one-off external call')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('shallow wrappers')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('Suppress a finding when the evidence does not establish a reusable missing boundary')

    const normalizedPrompt = mixedLayersWithoutAbstractionPrompt.toLowerCase()
    for (const triggerTerm of [
      'github',
      'gmail',
      'graphql',
      'websocket',
      'formatter',
      'context builder',
      'context-builder',
    ]) {
      expect(normalizedPrompt).not.toContain(triggerTerm)
    }
  })
})

describe('mixedLayersWithoutAbstractionRule', () => {
  it('exposes only the file-target handler and versions its cache behavior', () => {
    const handlers = mixedLayersWithoutAbstractionRule.create(createRuleContext())

    expect(Object.keys(handlers)).toEqual(['onTargetFile'])
    expect(handlers.onTargetFile).toBeTypeOf('function')
    expect(mixedLayersWithoutAbstractionRule.cacheKey).toEqual([
      mixedLayersWithoutAbstractionPrompt,
      'mixed-layer-findings-v1',
    ])
  })
})

describe('mixed layer structured findings', () => {
  it('creates strict provider-compatible schemas for nested relationships', () => {
    const parameters = createMixedLayerToolParameters()
    const findings = parameters.properties?.findings

    expect(parameters.additionalProperties).toBe(false)
    expect(parameters.required).toEqual(['findings'])
    expect(typeof findings).toBe('object')

    if (typeof findings !== 'object' || Array.isArray(findings.items) || typeof findings.items !== 'object') {
      throw new TypeError('Expected findings.items to be an object schema')
    }

    expect(findings.items.additionalProperties).toBe(false)
    expect(findings.items.required).toEqual([
      'boundaryKind',
      'confidence',
      'declaration',
      'line',
      'message',
      'relatedDeclarations',
      'suggestion',
    ])
    const relationships = findings.items.properties?.relatedDeclarations
    expect(typeof relationships).toBe('object')

    if (typeof relationships !== 'object' || Array.isArray(relationships.items) || typeof relationships.items !== 'object') {
      throw new TypeError('Expected relatedDeclarations.items to be an object schema')
    }

    expect(relationships.items.additionalProperties).toBe(false)
    expect(relationships.items.required).toEqual(['line', 'name', 'relationship'])
    expect(getDescription(mixedLayerFindingSchema)).toContain('declaration-level warning')
  })

  it('rejects unknown properties at every response level', () => {
    const validFinding = finding()
    const rootResult = safeParse(mixedLayerResponseSchema, {
      findings: [validFinding],
      unknownProperty: true,
    })
    const findingResult = safeParse(mixedLayerResponseSchema, {
      findings: [{ ...validFinding, unknownProperty: true }],
    })
    const relatedDeclarationResult = safeParse(mixedLayerResponseSchema, {
      findings: [
        {
          ...validFinding,
          relatedDeclarations: validFinding.relatedDeclarations.map(relatedDeclaration => ({
            ...relatedDeclaration,
            unknownProperty: true,
          })),
        },
      ],
    })

    expect(rootResult.success).toBe(false)
    expect(findingResult.success).toBe(false)
    expect(relatedDeclarationResult.success).toBe(false)
  })

  it('builds retry-aware numbered messages with output language instructions', () => {
    const messages = createMixedLayerMessages(
      'const readFrame = transport.read\nconst result = readFrame()\n',
      'Return the required tool object.',
      'Simplified Chinese',
    )

    expect(messages[0]?.role).toBe('system')
    expect(messages[0]?.content).toBe(mixedLayersWithoutAbstractionPrompt)
    expect(messages[1]).toEqual({ content: 'Return the required tool object.', role: 'user' })
    expect(messages[2]?.content).toContain('Write all human-readable finding messages and suggestions in this language: Simplified Chinese.')
    expect(messages[2]?.content).toContain('1 | const readFrame = transport.read')
    expect(messages[2]?.content).toContain('2 | const result = readFrame()')
  })

  it('deduplicates primary lines and removes invalid related declaration lines', () => {
    const normalized = normalizeMixedLayerFindings(
      [
        finding({
          relatedDeclarations: [
            { line: 1, name: 'readFrame', relationship: 'Move with the adapter.' },
            { line: 1, name: 'readFrame', relationship: 'Duplicate relationship.' },
            { line: 9, name: 'outside', relationship: 'Invalid line.' },
          ],
        }),
        finding({ declaration: 'duplicateLine', line: 2 }),
        finding({ declaration: 'fractionalLine', line: 1.5 }),
        finding({ declaration: 'outsideSource', line: 9 }),
      ],
      'const readFrame = transport.read\nconst result = readFrame()\n',
    )

    expect(normalized).toHaveLength(1)
    expect(normalized[0]?.declaration).toBe('interpretFrame')
    expect(normalized[0]?.relatedDeclarations).toEqual([
      { line: 1, name: 'readFrame', relationship: 'Move with the adapter.' },
    ])
  })

  it('reports every accepted primary declaration with relationship evidence', () => {
    const { context, diagnostics } = createReportContext()
    const findings = [
      finding(),
      finding({
        boundaryKind: 'consumer-policy',
        confidence: 'medium',
        declaration: 'selectFrames',
        line: 3,
        message: 'selectFrames mixes consumer policy with the external response owner.',
        suggestion: 'Keep selectFrames in the consumer and call the interpreted-frame interface.',
      }),
    ]

    reportMixedLayerFindings(context, '/repo/source.ts', findings)

    expect(diagnostics).toEqual([
      {
        evidence: {
          boundaryKind: 'data-adaptation',
          confidence: 'high',
          declaration: 'interpretFrame',
          relatedDeclarations: findings[0]?.relatedDeclarations,
          suggestion: findings[0]?.suggestion,
        },
        filePath: '/repo/source.ts',
        loc: { start: { column: 0, line: 2 } },
        message: findings[0]?.message,
      },
      {
        evidence: {
          boundaryKind: 'consumer-policy',
          confidence: 'medium',
          declaration: 'selectFrames',
          relatedDeclarations: findings[1]?.relatedDeclarations,
          suggestion: findings[1]?.suggestion,
        },
        filePath: '/repo/source.ts',
        loc: { start: { column: 0, line: 3 } },
        message: findings[1]?.message,
      },
    ])
  })
})
