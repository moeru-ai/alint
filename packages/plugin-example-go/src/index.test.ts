import type { RuleContext, SourceTarget } from '@alint-js/core'

import { getDescription } from 'valibot'
import { describe, expect, it } from 'vitest'

import {
  createGoBoundaryMessages,
  createReportFindingsToolParameters,
  goBoundaryFindingSchema,
  goBoundaryPlugin,
  goBoundaryPrompt,
  goBoundaryResponseSchema,
  reportGoBoundaryFindings,
} from './index'

function createRuleContext(): RuleContext {
  return {
    cwd: '/repo',
    id: 'go/responsibility-boundary',
    localId: 'responsibility-boundary',
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

function createSourceTarget(kind: SourceTarget['kind'], path = '/repo/internal/billing/service.go'): SourceTarget {
  const file = {
    language: 'text/plain',
    lines: ['package billing', '', 'func NewInvoiceService() {}'],
    path,
    text: 'package billing\n\nfunc NewInvoiceService() {}\n',
  }

  return {
    file,
    identity: `${kind}:demo`,
    kind,
    language: file.language,
    text: file.text,
  }
}

function getResponsibilityBoundaryRule() {
  const rule = goBoundaryPlugin.rules?.['responsibility-boundary']

  if (!rule) {
    throw new Error('Expected Go boundary plugin to expose responsibility-boundary rule')
  }

  return rule
}

describe('goBoundaryPlugin', () => {
  it('uses flat plugin shape with a generic Go responsibility-boundary config alias', () => {
    expect('scope' in goBoundaryPlugin).toBe(false)
    expect(goBoundaryPlugin.configs?.recommended).toEqual([
      {
        files: ['**/*.go'],
        language: 'text/plain',
        rules: {
          'go/responsibility-boundary': 'warn',
        },
      },
    ])
  })

  it('exposes the responsibility-boundary rule through onTarget only', () => {
    const handlers = getResponsibilityBoundaryRule().create(createRuleContext())

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

    await getResponsibilityBoundaryRule().create(context).onTarget?.(createSourceTarget('function'))

    expect(modelRequests).toBe(0)
  })

  it('ignores non-Go files before requesting a model', async () => {
    const context = createRuleContext()
    let modelRequests = 0
    context.model = async () => {
      modelRequests += 1
      throw new Error('Model should not be requested for non-Go targets')
    }

    await getResponsibilityBoundaryRule().create(context).onTarget?.(createSourceTarget('file', '/repo/internal/billing/service.ts'))

    expect(modelRequests).toBe(0)
  })
})

describe('createGoBoundaryMessages', () => {
  it('sends Go source code to the judge with stable line numbers', () => {
    const messages = createGoBoundaryMessages('package billing\nfunc NewInvoiceService() {}\n', undefined)

    expect(messages.at(-1)?.content).toContain([
      'Go code with line numbers:',
      '',
      '1 | package billing',
      '2 | func NewInvoiceService() {}',
      '3 | ',
    ].join('\n'))
  })

  it('includes output language instructions when provided', () => {
    const messages = createGoBoundaryMessages('package billing\n', undefined, 'Portuguese')

    expect(messages.at(-1)?.content).toContain('Write all human-readable finding messages and suggestions in this language: Portuguese.')
  })

  it('describes generic Go responsibility smells without datastore-specific trigger terms', () => {
    expect(goBoundaryPrompt).toContain('You are reviewing one Go source file.')
    expect(goBoundaryPrompt).toContain('single responsibility')
    expect(goBoundaryPrompt).toContain('cohesive constructor')
    expect(goBoundaryPrompt).toContain('few-shot examples')
    expect(goBoundaryPrompt).toContain('Report fragmented orchestration separately')
    expect(goBoundaryPrompt).toContain('Report cohesive misplaced domain clusters once')
    expect(goBoundaryPrompt).toContain('relatedDeclarations')
    expect(goBoundaryPrompt).toContain('Avoid file-level summary findings when they only repeat more specific cluster findings')
    expect(goBoundaryPrompt).toContain('Lazy setup and per-operation resource lifecycles are valid')
    expect(goBoundaryPrompt).toContain('opens short-lived connections lazily')
    expect(goBoundaryPrompt).toContain('Do not treat example names, domains, packages, or technologies as trigger terms')
    expect(goBoundaryPrompt).not.toContain('You are reviewing one Go source file from an internal datastore package')
    expect(goBoundaryPrompt).not.toContain('OAuth, OIDC, provider, seed, cache, Redis, S3, and schema-contract concerns are colocated')
    expect(goBoundaryPrompt).not.toContain('migrateSchema')
    expect(goBoundaryPrompt).not.toContain('RegisterBootstrapLifecycle')
    expect(goBoundaryPrompt).not.toContain('NewBootstrapRedisClient')
    expect(goBoundaryPrompt).not.toContain('Redis')
    expect(goBoundaryPrompt).not.toContain('meter')
    expect(goBoundaryPrompt).not.toContain('flux')
    expect(goBoundaryPrompt).not.toContain('debt')
    expect(goBoundaryPrompt).not.toContain('rate-limit')
    expect(goBoundaryPrompt).not.toContain('unitsPerFlux')
    expect(goBoundaryPrompt).not.toContain('OIDC')
    expect(goBoundaryPrompt).not.toContain('Ent')
    expect(goBoundaryPrompt).not.toContain('datastore')
  })

  it('stores finding output requirements in schema descriptions', () => {
    expect(getDescription(goBoundaryResponseSchema.entries.findings)).toContain('Go responsibility boundary')
    expect(getDescription(goBoundaryFindingSchema.pipe[0].entries.line)).toContain('left-column line number')
    expect(getDescription(goBoundaryFindingSchema.pipe[0].entries.category)).toContain('responsibility-boundary')
    expect(getDescription(goBoundaryFindingSchema.pipe[0].entries.relatedDeclarations.wrapped)).toContain('same cohesive issue cluster')
    expect(getDescription(goBoundaryFindingSchema.pipe[0].entries.suggestion)).toContain('design direction')
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

describe('reportGoBoundaryFindings', () => {
  it('maps semantic Go boundary findings into diagnostics with design evidence', () => {
    const diagnostics: Parameters<RuleContext['report']>[0][] = []
    const context = createRuleContext()
    context.report = diagnostic => diagnostics.push(diagnostic)

    reportGoBoundaryFindings(context, '/repo/internal/billing/service.go', [
      {
        category: 'constructor-cohesion',
        confidence: 'high',
        line: 42,
        message: 'Schema creation is split away from the database constructor.',
        suggestion: 'Move connection setup, migration, cleanup, and health ownership into a cohesive ent.go constructor.',
      },
    ])

    expect(diagnostics).toEqual([
      {
        evidence: {
          category: 'constructor-cohesion',
          confidence: 'high',
          suggestion: 'Move connection setup, migration, cleanup, and health ownership into a cohesive ent.go constructor.',
        },
        filePath: '/repo/internal/billing/service.go',
        loc: {
          start: {
            column: 0,
            line: 42,
          },
        },
        message: 'Schema creation is split away from the database constructor.',
      },
    ])
  })

  it('preserves related declarations for cohesive misplaced-domain clusters', () => {
    const diagnostics: Parameters<RuleContext['report']>[0][] = []
    const context = createRuleContext()
    context.report = diagnostic => diagnostics.push(diagnostic)

    reportGoBoundaryFindings(context, '/repo/internal/billing/service.go', [
      {
        category: 'domain-placement',
        confidence: 'medium',
        line: 30,
        message: 'A low-level adapter owns a business operation cluster.',
        relatedDeclarations: [
          {
            line: 12,
            name: 'OperationResult',
            role: 'result type',
          },
          {
            line: 18,
            name: 'operationScript',
            role: 'embedded operation data',
          },
        ],
        suggestion: 'Move the operation cluster near the domain owner and leave the adapter with a generic execution primitive.',
      },
    ])

    expect(diagnostics[0]?.evidence).toEqual({
      category: 'domain-placement',
      confidence: 'medium',
      relatedDeclarations: [
        {
          line: 12,
          name: 'OperationResult',
          role: 'result type',
        },
        {
          line: 18,
          name: 'operationScript',
          role: 'embedded operation data',
        },
      ],
      suggestion: 'Move the operation cluster near the domain owner and leave the adapter with a generic execution primitive.',
    })
  })
})
