import type { AgentAdapter, AgentRequest, AgentTool } from '@alint-js/core/agent'
import type { FileTarget, RuleContext } from '@alint-js/plugin'

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RepositoryReviewProtocolError } from '../../agents/repository-review'
import { overlappingEntrypointsInstructions, overlappingEntrypointsPrompt } from './prompt'
import { overlappingEntrypointsRule } from './rule'

const MANIFEST_SOURCE = [
  '{',
  '  "name": "@acme/mail",',
  '  "exports": {',
  '    ".": "./src/index.ts",',
  '    "./gmail": "./src/gmail/index.ts"',
  '  }',
  '}',
].join('\n')

const TARGET_SOURCE = [
  'export { GmailClient, formatGmailAddress } from \'./gmail/index\'',
  'export { CalendarClient } from \'./calendar/client\'',
].join('\n')

const GMAIL_BARREL_SOURCE = [
  'export { GmailClient } from \'./client\'',
  'export { formatGmailAddress } from \'./formatter\'',
].join('\n')

const CONSUMER_SOURCE = [
  'import { GmailClient, formatGmailAddress } from \'@acme/mail/gmail\'',
  'export const client = new GmailClient(formatGmailAddress)',
].join('\n')

function createContext(
  cwd: string,
  agent: AgentAdapter,
  report: RuleContext['report'] = () => {},
  recordUsage: RuleContext['metering']['recordUsage'] = () => {},
): RuleContext {
  return {
    agent,
    cwd,
    id: 'js/no-overlapping-entrypoints',
    localId: 'no-overlapping-entrypoints',
    logger: { debug: () => {} },
    metering: { recordUsage },
    model: async () => ({
      aliases: [],
      capabilities: ['tool-call'],
      id: 'review-model',
      name: 'Review model',
      params: {},
      provider: {
        endpoint: 'http://localhost:11434/v1',
        headers: {},
        id: 'review-provider',
        type: 'openai-compatible',
      },
    }),
    options: [],
    report,
    settings: {},
    src: {
      getText: target => target.text,
      readFile: async filePath => ({ language: 'typescript', lines: [''], path: filePath, text: '' }),
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

function createTarget(cwd: string): FileTarget {
  const file = {
    language: 'typescript',
    lines: TARGET_SOURCE.split('\n'),
    path: join(cwd, 'src/index.ts'),
    text: TARGET_SOURCE,
  }

  return {
    file,
    identity: 'file:src/index.ts',
    kind: 'file',
    language: file.language,
    text: file.text,
  }
}

function toolNamed(request: AgentRequest, name: string): AgentTool {
  const tool = request.tools.find(candidate => candidate.name === name)

  if (tool === undefined) {
    throw new Error(`Missing tool "${name}"`)
  }

  return tool
}

describe('no-overlapping-entrypoints', () => {
  let cwd: string
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'alint-no-overlapping-entrypoints-'))
    cwd = join(root, 'repo')
    await mkdir(join(cwd, 'src/gmail'), { recursive: true })
    await mkdir(join(cwd, 'src/calendar'), { recursive: true })
    await writeFile(join(cwd, 'package.json'), MANIFEST_SOURCE)
    await writeFile(join(cwd, 'src/index.ts'), TARGET_SOURCE)
    await writeFile(join(cwd, 'src/gmail/index.ts'), GMAIL_BARREL_SOURCE)
    await writeFile(join(cwd, 'src/calendar/client.ts'), 'export class CalendarClient {}\n')
    await writeFile(join(cwd, 'src/consumer.ts'), CONSUMER_SOURCE)
  })

  afterEach(async () => {
    await rm(root, { force: true, recursive: true })
  })

  it('reports one competing entrypoint pair after reading its manifest, barrels, and real imports', async () => {
    const finding = {
      category: 'overlapping-entrypoints',
      futureFailure: 'If a Gmail dependency or side-effect is added to the root export only, the subpath surface will drift and consumers importing @acme/mail/gmail can run different code or receive a different bundle.',
      line: 1,
      message: 'The root and ./gmail entrypoints compete as canonical imports for the same Gmail surface.',
      proof: 'package.json:4 and package.json:5 publish both paths; src/index.ts:1 and src/gmail/index.ts:1 expose the same Gmail client responsibility, while src/consumer.ts:1 uses the subpath.',
      relatedLocations: ['package.json:4', 'package.json:5', 'src/gmail/index.ts:1', 'src/consumer.ts:1'],
      suggestion: 'Choose and document one canonical Gmail surface, or separate the responsibilities exposed by the two entrypoints.',
    } as const
    const agent: AgentAdapter = async (request) => {
      const manifest = await toolNamed(request, 'read_file').execute({ path: 'package.json' })
      const rootBarrel = await toolNamed(request, 'read_file').execute({ path: 'src/index.ts' })
      const gmailBarrel = await toolNamed(request, 'read_file').execute({ path: 'src/gmail/index.ts' })
      const imports = await toolNamed(request, 'search_in_files').execute({ query: '@acme/mail/gmail' })

      expect(manifest).toContain('"./gmail": "./src/gmail/index.ts"')
      expect(rootBarrel).toContain('export { GmailClient, formatGmailAddress } from \'./gmail/index\'')
      expect(gmailBarrel).toContain('export { GmailClient } from \'./client\'')
      expect(gmailBarrel).toContain('export { formatGmailAddress } from \'./formatter\'')
      expect(imports).toContain('src/consumer.ts:1')
      expect(imports).toContain('@acme/mail/gmail')
      expect(await toolNamed(request, 'submit_review').execute({ findings: [finding] })).toBe('review submitted')

      return { answer: 'done' }
    }
    const diagnostics: Parameters<RuleContext['report']>[0][] = []

    await overlappingEntrypointsRule
      .create(createContext(cwd, agent, diagnostic => diagnostics.push(diagnostic)))
      .onTargetFile?.(createTarget(cwd))

    expect(diagnostics).toEqual([{
      evidence: {
        category: 'overlapping-entrypoints',
        futureFailure: finding.futureFailure,
        proof: finding.proof,
        relatedLocations: finding.relatedLocations,
        suggestion: finding.suggestion,
      },
      filePath: join(cwd, 'src/index.ts'),
      loc: { start: { column: 0, line: 1 } },
      message: finding.message,
    }])
  })

  it('uses the repository review protocol with non-cacheable file-only wiring', async () => {
    let request: AgentRequest | undefined
    const usageRecords: Parameters<RuleContext['metering']['recordUsage']>[0][] = []
    const agent: AgentAdapter = async (nextRequest) => {
      request = nextRequest
      await toolNamed(nextRequest, 'submit_review').execute({ findings: [] })

      return {
        answer: 'done',
        usage: { inputTokens: 13, outputTokens: 8, totalTokens: 21 },
      }
    }
    const context = createContext(cwd, agent, () => {}, usage => usageRecords.push(usage))
    const handlers = overlappingEntrypointsRule.create(context)

    await handlers.onTargetFile?.(createTarget(cwd))

    expect(overlappingEntrypointsRule.cache).toBe(false)
    expect(handlers.onTargetFile).toBeTypeOf('function')
    expect('onTargetClass' in handlers).toBe(false)
    expect('onTargetDirectory' in handlers).toBe(false)
    expect('onTargetFunction' in handlers).toBe(false)
    expect('onTargetProject' in handlers).toBe(false)
    expect('onTargetWith' in handlers).toBe(false)
    expect(request).toBeDefined()
    expect(request?.instructions).toContain(overlappingEntrypointsInstructions)
    expect(request?.prompt).toContain(overlappingEntrypointsPrompt)
    expect(request?.tools.map(tool => tool.name)).toEqual([
      'read_file',
      'list_files',
      'search_files',
      'search_in_files',
      'submit_review',
    ])
    expect(toolNamed(request!, 'submit_review').parameters).toMatchObject({
      properties: {
        findings: {
          items: {
            properties: {
              category: { enum: ['overlapping-entrypoints'] },
              futureFailure: { minLength: 1, type: 'string' },
              relatedLocations: { minItems: 1, type: 'array' },
            },
            required: ['category', 'futureFailure', 'line', 'message', 'proof', 'relatedLocations', 'suggestion'],
          },
        },
      },
    })
    expect(usageRecords).toEqual([{
      filePath: join(cwd, 'src/index.ts'),
      inputTokens: 13,
      metadata: { operation: 'overlapping-entrypoints-review' },
      modelId: 'review-model',
      outputTokens: 8,
      providerId: 'review-provider',
      ruleId: 'js/no-overlapping-entrypoints',
      totalTokens: 21,
    }])
  })

  it('rejects findings missing required future-failure and related-location evidence', async () => {
    let rejection: unknown
    const agent: AgentAdapter = async (request) => {
      await toolNamed(request, 'search_in_files').execute({ query: '@acme/mail/gmail' })
      await toolNamed(request, 'read_file').execute({ path: 'package.json' })
      rejection = await toolNamed(request, 'submit_review').execute({
        findings: [{
          category: 'overlapping-entrypoints',
          line: 1,
          message: 'The root and Gmail entrypoints overlap.',
          proof: 'Both expose the Gmail client.',
          suggestion: 'Choose a canonical surface.',
        }],
      })

      return { answer: 'done' }
    }

    await expect(overlappingEntrypointsRule.create(createContext(cwd, agent)).onTargetFile?.(createTarget(cwd)))
      .rejects
      .toThrow(RepositoryReviewProtocolError)
    expect(rejection).toMatch(/review rejected/i)
  })

  it('calibrates competing surfaces, future failures, remediation choices, and suppressions', () => {
    const contract = `${overlappingEntrypointsInstructions}\n${overlappingEntrypointsPrompt}`

    expect(contract).toMatch(/nearest package\.json.*exports/is)
    expect(contract).toMatch(/target.*root barrel.*overlapping subpath barrel/is)
    expect(contract).toMatch(/search.*real import usage/is)
    expect(contract).toMatch(/absence.*in-repository consumers.*not.*suppress/is)
    expect(contract).toMatch(/root.*export \*.*provider.*manifest.*subpath.*same barrel/is)
    expect(contract).toMatch(/high-signal.*report.*unless.*distinct roles/is)
    expect(contract).toMatch(/private.*true.*not.*entrypoint.*internal/is)
    expect(contract).toMatch(/symbol collision.*root.*ambiguous.*subpath.*work/is)
    expect(contract).toMatch(/one finding per competing entrypoint pair/i)
    expect(contract).toMatch(/not.*per overlapping symbol/i)
    expect(contract).toMatch(/anchor.*target export declaration/i)
    expect(contract).toMatch(/materially.*same symbol.*responsibility surface/is)
    expect(contract).toMatch(/compete.*canonical import paths/is)
    expect(contract).toMatch(/exact repo-relative path:line/i)
    expect(contract).toMatch(/asymmetric.*export.*dependency.*side-effect.*drift.*leak.*divergence.*consumer.*bundle.*runtime/is)
    expect(contract).toMatch(/canonical surface.*separate responsibilities/is)
    expect(contract).toMatch(/not automatically.*root-only.*subpath-only/is)
    expect(contract).toMatch(/compatibility.*deprecation alias/is)
    expect(contract).toMatch(/flat convenience.*advanced subpath.*different roles/is)
    expect(contract).toMatch(/conditional browser.*node exports/is)
    expect(contract).toMatch(/types.*runtime splits/is)
    expect(contract).toMatch(/internal.*private entrypoints/is)
    expect(contract).toMatch(/superficial shared symbols.*surfaces remain distinct/is)
    expect(contract).toMatch(/do not report solely.*package\.json.*both.*['"`]\.['"`].*subpaths/is)
  })

  it('submits a clean review for a documented compatibility alias after reading repository evidence', async () => {
    const compatibilityDocumentation = [
      '# Import compatibility',
      '',
      '`@acme/mail/gmail` is a deprecated compatibility alias for legacy consumers.',
      'New code must import the Gmail API from the canonical `@acme/mail` root.',
    ].join('\n')
    await writeFile(join(cwd, 'README.md'), compatibilityDocumentation)
    const diagnostics: Parameters<RuleContext['report']>[0][] = []
    const agent: AgentAdapter = async (request) => {
      const manifest = await toolNamed(request, 'read_file').execute({ path: 'package.json' })
      const rootBarrel = await toolNamed(request, 'read_file').execute({ path: 'src/index.ts' })
      const gmailBarrel = await toolNamed(request, 'read_file').execute({ path: 'src/gmail/index.ts' })
      const documentation = await toolNamed(request, 'read_file').execute({ path: 'README.md' })
      const imports = await toolNamed(request, 'search_in_files').execute({ query: '@acme/mail/gmail' })

      expect(manifest).toContain('"exports"')
      expect(rootBarrel).toContain('GmailClient')
      expect(gmailBarrel).toContain('GmailClient')
      expect(documentation).toContain('deprecated compatibility alias')
      expect(imports).toContain('src/consumer.ts:1')
      expect(await toolNamed(request, 'submit_review').execute({ findings: [] })).toBe('review submitted')

      return { answer: 'done' }
    }

    await overlappingEntrypointsRule
      .create(createContext(cwd, agent, diagnostic => diagnostics.push(diagnostic)))
      .onTargetFile?.(createTarget(cwd))

    expect(diagnostics).toEqual([])
  })
})
