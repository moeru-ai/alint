import type { ResolvedModel, RuleContext, SourceTarget } from '@alint-js/plugin'

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getDescription } from 'valibot'
import { describe, expect, it } from 'vitest'

import { reviewRepository } from './agents/repository-review'
import { resolveRepositoryReviewAgent } from './agents/repository-review/agent'
import {
  collectResponsibilityBoundaryContext,
  createGoPlugin,
  createReportFindingsToolParameters,
  createResponsibilityBoundaryMessages,
  createTools,
  duplicatedConversionKnowledgeInstructions,
  duplicatedConversionKnowledgePrompt,
  goPlugin,
  noRawSqlBypassingEntInstructions,
  noRawSqlBypassingEntPrompt,
  privateProtobufToolkitPrompt,
  reportResponsibilityBoundaryFindings,
  responsibilityBoundaryFindingSchema,
  responsibilityBoundaryPrompt,
  responsibilityBoundaryResponseSchema,
} from './index'

function createResolvedModel(): ResolvedModel {
  return {
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
}

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
    model: async () => createResolvedModel(),
    options: [],
    report: () => {},
    settings: {},
    src: {
      extract: () => Promise.reject(new Error('not used by this rule')), // stub
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

function createSourceTarget<Kind extends SourceTarget['kind']>(kind: Kind, path = '/repo/internal/billing/service.go'): SourceTarget & { kind: Kind } {
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
  const rule = goPlugin.rules?.['responsibility-boundary']

  if (!rule) {
    throw new Error('Expected Go boundary plugin to expose responsibility-boundary rule')
  }

  return rule
}

describe('goPlugin', () => {
  it('creates the Go boundary plugin without requiring callers to inject an agent adapter', () => {
    const plugin = createGoPlugin()

    expect(plugin.rules?.['duplicated-conversion-knowledge']).toBeDefined()
    expect(plugin.rules?.['no-raw-sql-bypassing-ent']).toBeDefined()
    expect(plugin.rules?.['private-protobuf-toolkit']).toBeDefined()
    expect(plugin.rules?.['responsibility-boundary']).toBeDefined()
    expect(plugin.configs?.example).toEqual(goPlugin.configs?.example)
  })

  it('uses flat plugin shape with a generic Go responsibility-boundary config alias', () => {
    expect('scope' in goPlugin).toBe(false)
    expect(goPlugin.configs?.example).toEqual([
      {
        files: ['**/*.go'],
        language: 'text/plain',
        rules: {
          'go/duplicated-conversion-knowledge': 'warn',
          'go/private-protobuf-toolkit': 'warn',
          'go/responsibility-boundary': 'warn',
        },
      },
    ])
  })

  it('exposes the responsibility-boundary rule through onTargetFile only', () => {
    const handlers = getResponsibilityBoundaryRule().create(createRuleContext())

    expect(handlers.onTargetFile).toBeTypeOf('function')
    expect('onFile' in handlers).toBe(false)
    expect('onFunction' in handlers).toBe(false)
    expect('onClass' in handlers).toBe(false)
  })

  it('ignores non-Go files before requesting a model', async () => {
    const context = createRuleContext()
    let modelRequests = 0
    context.model = async () => {
      modelRequests += 1
      throw new Error('Model should not be requested for non-Go targets')
    }

    await getResponsibilityBoundaryRule().create(context).onTargetFile?.(createSourceTarget('file', '/repo/internal/billing/service.ts'))

    expect(modelRequests).toBe(0)
  })

  it('documents Go conversion smells with prompt-only rule modules', () => {
    expect(privateProtobufToolkitPrompt).toContain('private boundary-translation toolkit')
    expect(privateProtobufToolkitPrompt).toContain('cluster of at least two local helper functions')
    expect(privateProtobufToolkitPrompt).toContain('Do not report a short helper solely because it is short')

    expect(duplicatedConversionKnowledgePrompt).toContain('duplicated boundary-translation knowledge')
    expect(duplicatedConversionKnowledgeInstructions).toContain('Use repository search tools')
    expect(duplicatedConversionKnowledgeInstructions).toContain('futureFailure')
    expect(privateProtobufToolkitPrompt).not.toMatch(/protobuf|grpc|structpb|timestamppb|durationpb/i)
    expect(duplicatedConversionKnowledgePrompt).not.toMatch(/protobuf|grpc|structpb|timestamppb|durationpb/i)
    expect(duplicatedConversionKnowledgeInstructions).not.toMatch(/protobuf|grpc|structpb|timestamppb|durationpb/i)
  })

  it('keeps Ent raw SQL bypass review manually opt-in', () => {
    const exampleConfig = goPlugin.configs?.example

    expect(Array.isArray(exampleConfig)).toBe(true)

    if (!Array.isArray(exampleConfig)) {
      throw new TypeError('Expected example config to be an array')
    }

    expect(exampleConfig[0]?.rules).not.toHaveProperty('go/no-raw-sql-bypassing-ent')
    expect(noRawSqlBypassingEntPrompt).toContain('raw SQL bypasses generated Ent schema ownership')
    expect(noRawSqlBypassingEntInstructions).toContain('Use repository search tools')
    expect(noRawSqlBypassingEntInstructions).toContain('escape hatch')
  })

  it('provides a default repository review agent so TOML configs can enable Go repository rules', () => {
    expect(resolveRepositoryReviewAgent(createRuleContext())).toBeTypeOf('function')
  })

  it('keeps exploratory repository read failures inside the agent review', async () => {
    const context = createRuleContext()
    context.agent = async (request) => {
      const readFile = request.tools.find(tool => tool.name === 'read_file')
      const submitReview = request.tools.find(tool => tool.name === 'submit_review')

      if (!readFile || !submitReview) {
        throw new Error('Expected repository review tools')
      }

      await expect(readFile.execute({ path: 'internal/missing.go' })).resolves.toContain('read_file failed:')
      await submitReview.execute({ findings: [] })

      return { answer: 'submitted' }
    }

    await expect(reviewRepository(context, createSourceTarget('file'), {
      allowedCategories: ['example'],
      instructions: 'Review example.',
      operation: 'test-review',
      prompt: 'Review example.',
    })).resolves.toEqual([])
  })
})

describe('createResponsibilityBoundaryMessages', () => {
  it('sends Go source code to the judge with stable line numbers', () => {
    const messages = createResponsibilityBoundaryMessages('package billing\nfunc NewInvoiceService() {}\n', undefined)

    expect(messages.at(-1)?.content).toContain([
      'Go code with line numbers:',
      '',
      '1 | package billing',
      '2 | func NewInvoiceService() {}',
      '3 | ',
    ].join('\n'))
  })

  it('includes output language instructions when provided', () => {
    const messages = createResponsibilityBoundaryMessages('package billing\n', undefined, 'Portuguese')

    expect(messages.at(-1)?.content).toContain('Write all human-readable finding messages and suggestions in this language: Portuguese.')
  })

  it('includes supplemental project context when provided', () => {
    const messages = createResponsibilityBoundaryMessages(
      'package billing\n',
      undefined,
      undefined,
      [
        'Same-package files:',
        '- internal/billing/wire.go',
        '',
        'Reference snippets:',
        '- internal/billing/module.go:12: fx.Invoke(RunBillingServer)',
      ].join('\n'),
    )

    expect(messages.at(-1)?.content).toContain('Supplemental project context:')
    expect(messages.at(-1)?.content).toContain('Same-package files:')
    expect(messages.at(-1)?.content).toContain('fx.Invoke(RunBillingServer)')
  })

  it('describes generic Go responsibility smells without datastore-specific trigger terms', () => {
    expect(responsibilityBoundaryPrompt).toContain('You are reviewing one Go source file.')
    expect(responsibilityBoundaryPrompt).toContain('single responsibility')
    expect(responsibilityBoundaryPrompt).toContain('cohesive constructor')
    expect(responsibilityBoundaryPrompt).toContain('few-shot examples')
    expect(responsibilityBoundaryPrompt).toContain('Report fragmented orchestration separately')
    expect(responsibilityBoundaryPrompt).toContain('Report cohesive misplaced domain clusters once')
    expect(responsibilityBoundaryPrompt).toContain('Uber Fx lifecycle code often intentionally separates constructors from invoked runner functions')
    expect(responsibilityBoundaryPrompt).toContain('grpc-gateway registration commonly bridges generated gRPC handlers into an HTTP router')
    expect(responsibilityBoundaryPrompt).toContain('Do not report log.Fatal solely because it is inside a serve goroutine')
    expect(responsibilityBoundaryPrompt).toContain('Do not report a constructor solely because no Close/Stop lifecycle hook is visible in the same file')
    expect(responsibilityBoundaryPrompt).toContain('Do not report isolated resource-leak, missing Close-on-error, retry, timeout, or error-handling bugs under this rule')
    expect(responsibilityBoundaryPrompt).toContain('Do not report unused functions, dead wiring, missing module registration, or zero callers under this rule')
    expect(responsibilityBoundaryPrompt).toContain('Generic Redis lock helpers are acceptable inside a focused Redis adapter')
    expect(responsibilityBoundaryPrompt).toContain('even when reference context shows no current callers')
    expect(responsibilityBoundaryPrompt).toContain('Redis key constants belong in Redis key packages')
    expect(responsibilityBoundaryPrompt).toContain('A focused infrastructure adapter may expose a thin integration factory')
    expect(responsibilityBoundaryPrompt).toContain('session/cache/store wrappers')
    expect(responsibilityBoundaryPrompt).toContain('Generic utility files are not automatically responsibility-boundary findings')
    expect(responsibilityBoundaryPrompt).toContain('Misleading names such as encryption-vs-hashing may be naming/API-design concerns')
    expect(responsibilityBoundaryPrompt).toContain('Similar method names on different response or error types are not duplication by themselves')
    expect(responsibilityBoundaryPrompt).toContain('one may intentionally keep the first violation while the aggregate collects all violations')
    expect(responsibilityBoundaryPrompt).toContain('API error packages may own adapters from validation frameworks into the project')
    expect(responsibilityBoundaryPrompt).toContain('Use supplemental context when present')
    expect(responsibilityBoundaryPrompt).toContain('relatedDeclarations')
    expect(responsibilityBoundaryPrompt).toContain('Avoid file-level summary findings when they only repeat more specific cluster findings')
    expect(responsibilityBoundaryPrompt).toContain('Lazy setup and per-operation resource lifecycles are valid')
    expect(responsibilityBoundaryPrompt).toContain('opens short-lived connections lazily')
    expect(responsibilityBoundaryPrompt).toContain('a thin storage-backed session/cache/store factory inside the storage adapter file')
    expect(responsibilityBoundaryPrompt).toContain('Do not treat example names, domains, packages, or technologies as trigger terms')
    expect(responsibilityBoundaryPrompt).not.toContain('You are reviewing one Go source file from an internal datastore package')
    expect(responsibilityBoundaryPrompt).not.toContain('OAuth, OIDC, provider, seed, cache, Redis, S3, and schema-contract concerns are colocated')
    expect(responsibilityBoundaryPrompt).not.toContain('migrateSchema')
    expect(responsibilityBoundaryPrompt).not.toContain('RegisterBootstrapLifecycle')
    expect(responsibilityBoundaryPrompt).not.toContain('NewBootstrapRedisClient')
    expect(responsibilityBoundaryPrompt).not.toContain('flux')
    expect(responsibilityBoundaryPrompt).not.toContain('debt')
    expect(responsibilityBoundaryPrompt).not.toContain('rate-limit')
    expect(responsibilityBoundaryPrompt).not.toContain('unitsPerFlux')
    expect(responsibilityBoundaryPrompt).not.toContain('OIDC')
    expect(responsibilityBoundaryPrompt).not.toContain('Ent')
    expect(responsibilityBoundaryPrompt).not.toContain('datastore')
  })

  it('stores finding output requirements in schema descriptions', () => {
    expect(getDescription(responsibilityBoundaryResponseSchema.entries.findings)).toContain('Go responsibility boundary')
    expect(getDescription(responsibilityBoundaryFindingSchema.pipe[0].entries.line)).toContain('left-column line number')
    expect(getDescription(responsibilityBoundaryFindingSchema.pipe[0].entries.category)).toContain('responsibility-boundary')
    expect(getDescription(responsibilityBoundaryFindingSchema.pipe[0].entries.relatedDeclarations.wrapped)).toContain('same cohesive issue cluster')
    expect(getDescription(responsibilityBoundaryFindingSchema.pipe[0].entries.suggestion)).toContain('design direction')
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

describe('collectResponsibilityBoundaryContext', () => {
  it('exposes generic project tools for the internal scout to list, read, and search files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-go-scout-'))
    const cwd = join(root, 'project')
    const filePath = join(cwd, 'internal/billing/service.go')
    const modulePath = join(cwd, 'internal/billing/module.go')
    const outsidePath = join(root, 'outside.txt')
    const source = 'package billing\n\nfunc RunBillingServer() {}\n'
    const context = createRuleContext()
    context.cwd = cwd

    await mkdir(join(cwd, 'internal/billing'), { recursive: true })
    await mkdir(join(cwd, 'vendor/generated'), { recursive: true })
    await writeFile(filePath, source)
    await writeFile(modulePath, 'package billing\n\nfunc Module() {\n\tfx.Invoke(RunBillingServer)\n}\n')
    await writeFile(join(cwd, 'README.md'), '# Billing\n')
    await writeFile(join(cwd, 'vendor/generated/ignored.go'), 'package generated\n\nfunc RunBillingServer() {}\n')
    await writeFile(outsidePath, 'outside project root\n')

    const tools = createTools(cwd)
    const listFiles = tools.find(tool => tool.name === 'list_files')
    const readFile = tools.find(tool => tool.name === 'read_file')
    const searchFiles = tools.find(tool => tool.name === 'search_files')
    const searchInFiles = tools.find(tool => tool.name === 'search_in_files')

    if (!listFiles || !readFile || !searchFiles || !searchInFiles) {
      throw new Error('Expected scout project tools')
    }

    const listed = await listFiles.execute({
      ignore: ['vendor/**'],
      patterns: ['**/*.go', '**/*.md'],
    })
    const outside = await readFile.execute({ path: outsidePath })
    const fileMatches = await searchFiles.execute({ patterns: '**/*.go', query: 'module' })
    const contentMatches = await searchInFiles.execute({ patterns: '**/*.go', query: 'RunBillingServer' })
    const supplemental = await collectResponsibilityBoundaryContext(context, filePath, source)

    expect(String(listed)).toContain('internal/billing/module.go')
    expect(String(listed)).toContain('README.md')
    expect(String(listed)).not.toContain('vendor/generated/ignored.go')
    expect(String(outside)).toContain('outside project root')
    expect(String(fileMatches)).toContain('internal/billing/module.go')
    expect(String(contentMatches)).toContain('internal/billing/module.go')
    expect(String(contentMatches)).not.toContain('vendor/generated/ignored.go')
    expect(supplemental).toContain('Same-package files:')
    expect(supplemental).toContain('internal/billing/module.go')
    expect(supplemental).toContain('RunBillingServer')
  })
})

describe('reportResponsibilityBoundaryFindings', () => {
  it('maps semantic Go boundary findings into diagnostics with design evidence', () => {
    const diagnostics: Parameters<RuleContext['report']>[0][] = []
    const context = createRuleContext()
    context.report = diagnostic => diagnostics.push(diagnostic)

    reportResponsibilityBoundaryFindings(context, '/repo/internal/billing/service.go', [
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

    reportResponsibilityBoundaryFindings(context, '/repo/internal/billing/service.go', [
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
