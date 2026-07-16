import type { GenerateStructuredOptions } from '@alint-js/core/structured-output'
import type { FileTarget, RuleContext } from '@alint-js/plugin'

import type { MixedLayerFinding } from './rule'

import { getDescription, safeParse } from 'valibot'
import { describe, expect, it, vi } from 'vitest'

import { mixedLayersWithoutAbstractionPrompt } from './prompt'
import {
  createMixedLayerMessages,
  createMixedLayersWithoutAbstractionRule,
  createMixedLayerToolParameters,
  mixedLayerFindingSchema,
  mixedLayerResponseSchema,
  mixedLayersWithoutAbstractionRule,
  normalizeMixedLayerFindings,
  reportMixedLayerFindings,
} from './rule'

function createFileTarget(source: string): FileTarget {
  const file = {
    language: 'typescript',
    lines: source.split('\n'),
    path: '/repo/source.ts',
    text: source,
  }

  return {
    file,
    identity: 'file:source.ts',
    kind: 'file',
    language: file.language,
    text: source,
  }
}

function createReportContext() {
  const diagnostics: Parameters<RuleContext['report']>[0][] = []
  const context: Pick<RuleContext, 'report'> = {
    report: diagnostic => diagnostics.push(diagnostic),
  }

  return { context, diagnostics }
}

function createRuleContext() {
  const diagnostics: Parameters<RuleContext['report']>[0][] = []
  const model: Awaited<ReturnType<RuleContext['model']>> = {
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
  }
  const signal = new AbortController().signal
  const context: RuleContext = {
    cwd: '/repo',
    id: 'example/no-mixed-layers-without-abstraction',
    localId: 'no-mixed-layers-without-abstraction',
    logger: { debug: () => {} },
    metering: { recordUsage: () => {} },
    model: async () => model,
    outputLanguage: 'Simplified Chinese',
    report: diagnostic => diagnostics.push(diagnostic),
    settings: {},
    signal,
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

  return { context, diagnostics, model, signal }
}

function finding(overrides: Partial<MixedLayerFinding> = {}): MixedLayerFinding {
  return {
    boundaryKind: 'data-adaptation',
    confidence: 'high',
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
    expect(mixedLayersWithoutAbstractionPrompt).toContain('identify the focused owner the suggestion would create')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('already exists in the reviewed source as a stable boundary')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('callers do not need the lower-level knowledge')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('Multiple cohesive implementation steps inside that owner do not by themselves establish mixed ownership')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('only rename, re-extract, or recreate that existing boundary')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('move cohesive internals behind materially the same interface')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('embeds a separate consuming workflow or policy')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('leaks lower-level details to callers')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('owns responsibilities outside its promised boundary that can change or be reused independently')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('callable from outside the current consuming feature')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('without importing or understanding that consumer')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('The presence of a container or construction helper is not sufficient evidence of that boundary')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('Separate the boundary decision from finding granularity')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('Once a missing boundary is established, keep each declaration as a primary finding when it independently owns')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('external access, a reusable integration operation, response interpretation or adaptation, or consumer-specific policy')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('relatedDeclarations may cue supporting declarations and cooperation, movement, or call relationships between primary findings')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('must not replace a primary finding for an independently owned operation, adaptation, or policy')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('Every primary finding must materially participate in the identified missing boundary or responsibility flow')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('Do not report a declaration merely because it coexists in a source that otherwise qualifies')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('Its suggestion or relatedDeclarations must show how it belongs to that cluster')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('move with another declaration, call through the boundary, or remove a direct dependency')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('Mandatory pre-return audit:')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('Owner-recursion audit:')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('compare its proposed owner and interface with the reviewed source\'s existing public semantic boundary')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('If they are materially the same and callers already avoid lower-level knowledge, remove the finding')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('A focused owner that consumes an external mechanism to deliver its promised interface is not itself the consuming-feature smell')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('Primary-coverage audit:')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('Inventory every declaration in each qualifying cluster that independently owns external access, a reusable operation, adaptation or interpretation, or consumer policy')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('Each must appear exactly once as a primary finding; mentioning it only in relatedDeclarations is insufficient')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('Cluster audit:')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('Remove declarations that do not materially participate in that same missing-boundary flow')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('Cross-cue primary declarations through findings and relatedDeclarations, but do not duplicate one declaration across findings')

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
    const { context } = createRuleContext()
    const handlers = mixedLayersWithoutAbstractionRule.create(context)

    expect(Object.keys(handlers)).toEqual(['onTargetFile'])
    expect(handlers.onTargetFile).toBeTypeOf('function')
    expect(mixedLayersWithoutAbstractionRule.cacheKey).toEqual([
      mixedLayersWithoutAbstractionPrompt,
      'mixed-layer-findings-v2',
    ])
  })

  it('forwards runtime dependencies and reports only normalized findings', async () => {
    const source = [
      'const readFrame = transport.read',
      'function interpretFrame() {}',
      'const selected = interpretFrame()',
    ].join('\n')
    const generate = vi.fn(async (
      _options: GenerateStructuredOptions<typeof mixedLayerResponseSchema>,
    ): Promise<{ findings: MixedLayerFinding[] }> => ({
      findings: [
        finding(),
        finding({ message: 'Duplicate finding for the same declaration.' }),
        finding({ declaration: 'outsideSource', line: 9 }),
      ],
    }))
    const { context, diagnostics, model, signal } = createRuleContext()
    const handlers = createMixedLayersWithoutAbstractionRule(generate).create(context)

    if (!handlers.onTargetFile) {
      throw new TypeError('Expected a file-target handler')
    }

    await handlers.onTargetFile(createFileTarget(source))

    expect(generate).toHaveBeenCalledTimes(1)
    const call = generate.mock.calls[0]
    if (!call) {
      throw new TypeError('Expected structured generation options')
    }

    const [options] = call
    expect(options.logger).toBe(context.logger)
    expect(options.metering).toBe(context.metering)
    expect(options.model).toBe(model)
    expect(options.signal).toBe(signal)
    expect(options.schema).toBe(mixedLayerResponseSchema)
    expect(options.operation).toBe('mixed-layers-without-abstraction-judge')

    const messages = options.createMessages()
    expect(messages.at(-1)?.content).toContain('Write all human-readable finding messages and suggestions in this language: Simplified Chinese.')
    expect(messages.at(-1)?.content).toContain('1 | const readFrame = transport.read')
    expect(messages.at(-1)?.content).toContain('2 | function interpretFrame() {}')
    expect(messages.at(-1)?.content).toContain('3 | const selected = interpretFrame()')
    expect(diagnostics).toEqual([
      {
        evidence: {
          boundaryKind: 'data-adaptation',
          confidence: 'high',
          declaration: 'interpretFrame',
          relatedDeclarations: [
            {
              line: 1,
              name: 'readFrame',
              relationship: 'Move with interpretFrame behind the same external integration interface.',
            },
          ],
          suggestion: 'Move readFrame and interpretFrame into a focused integration owner and expose interpreted frames.',
        },
        filePath: '/repo/source.ts',
        loc: { start: { column: 0, line: 2 } },
        message: 'interpretFrame makes a reusable external response contract inside the consumer.',
      },
    ])
  })

  it('propagates generation failures without reporting diagnostics', async () => {
    const failure = new Error('generation failed')
    const generate = vi.fn(async (
      _options: GenerateStructuredOptions<typeof mixedLayerResponseSchema>,
    ): Promise<{ findings: MixedLayerFinding[] }> => {
      throw failure
    })
    const { context, diagnostics } = createRuleContext()
    const handlers = createMixedLayersWithoutAbstractionRule(generate).create(context)

    if (!handlers.onTargetFile) {
      throw new TypeError('Expected a file-target handler')
    }

    await expect(handlers.onTargetFile(createFileTarget('const source = external.read()'))).rejects.toBe(failure)
    expect(diagnostics).toEqual([])
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

  it('deduplicates primary declaration identities and removes invalid related declaration lines', () => {
    const normalized = normalizeMixedLayerFindings(
      [
        finding({
          relatedDeclarations: [
            { line: 1, name: 'readFrame', relationship: 'Move with the adapter.' },
            { line: 1, name: 'readFrame', relationship: 'Duplicate relationship.' },
            { line: 9, name: 'outside', relationship: 'Invalid line.' },
          ],
        }),
        finding({ message: 'Duplicate finding for the same declaration.' }),
        finding({ declaration: 'selectFrames', line: 2 }),
        finding({ declaration: 'fractionalLine', line: 1.5 }),
        finding({ declaration: 'outsideSource', line: 9 }),
      ],
      'const readFrame = transport.read\nconst result = readFrame()\n',
    )

    expect(normalized).toHaveLength(2)
    expect(normalized[0]?.declaration).toBe('interpretFrame')
    expect(normalized[0]?.relatedDeclarations).toEqual([
      { line: 1, name: 'readFrame', relationship: 'Move with the adapter.' },
    ])
    expect(normalized[1]?.declaration).toBe('selectFrames')
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
