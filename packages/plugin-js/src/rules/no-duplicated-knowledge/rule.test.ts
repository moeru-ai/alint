import type { AgentAdapter, AgentRequest, AgentTool } from '@alint-js/core/agent'
import type { FileTarget, RuleContext } from '@alint-js/plugin'

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RepositoryReviewProtocolError } from '../../agents/repository-review'
import { duplicatedKnowledgeInstructions, duplicatedKnowledgePrompt } from './prompt'
import { duplicatedKnowledgeRule } from './rule'

const TARGET_SOURCE = [
  'export function formatMessage(input: Message) {',
  '  return {',
  '    subject: input.subject.slice(0, 998),',
  '  }',
  '}',
  '',
  'export function loadMessage() {',
  '  pending = fetchMessage().catch((error) => { pending = undefined; throw error })',
  '  return pending',
  '}',
].join('\n')

function createContext(cwd: string, agent: AgentAdapter, report: RuleContext['report'] = () => {}): RuleContext {
  return {
    agent,
    cwd,
    id: 'js/no-duplicated-knowledge',
    localId: 'no-duplicated-knowledge',
    logger: { debug: () => {} },
    metering: { recordUsage: () => {} },
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
    path: join(cwd, 'src/gmail/formatter.ts'),
    text: TARGET_SOURCE,
  }

  return {
    file,
    identity: 'file:src/gmail/formatter.ts',
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

describe('no-duplicated-knowledge', () => {
  let cwd: string
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'alint-no-duplicated-knowledge-'))
    cwd = join(root, 'repo')
    await mkdir(join(cwd, 'src/gmail'), { recursive: true })
    await mkdir(join(cwd, 'src/shared'), { recursive: true })
    await writeFile(join(cwd, 'src/gmail/formatter.ts'), TARGET_SOURCE)
    await writeFile(join(cwd, 'src/gmail/parser.ts'), Array.from(
      { length: 41 },
      (_, index) => index === 40 ? 'export const MAX_SUBJECT_LENGTH = 998' : `// parser line ${index + 1}`,
    ).join('\n'))
    await writeFile(join(cwd, 'src/shared/async-memo.ts'), Array.from(
      { length: 12 },
      (_, index) => index === 11 ? 'export function resettableMemo() {}' : `// memo line ${index + 1}`,
    ).join('\n'))
    await writeFile(join(cwd, '.env.local'), 'PRIVATE_TOKEN=do-not-read\n')
  })

  afterEach(async () => {
    await rm(root, { force: true, recursive: true })
  })

  it('maps policy and mechanism findings to diagnostics with complete evidence', async () => {
    const policyFinding = {
      category: 'policy',
      futureFailure: 'If the subject bound changes in the parser only, the formatter keeps truncating at 998 and silently diverges from accepted input.',
      line: 3,
      message: 'The subject bound is maintained independently by the parser and formatter.',
      proof: 'src/gmail/formatter.ts:3 truncates at 998 while src/gmail/parser.ts:41 independently rejects subjects longer than 998.',
      relatedLocations: ['src/gmail/parser.ts:41'],
      suggestion: 'Own the subject bound in one domain constraint consumed by both parser and formatter.',
    } as const
    const mechanismFinding = {
      category: 'mechanism',
      futureFailure: 'If retry backoff is added to the shared memo helper only, this inline rejection reset keeps retrying immediately and can overload the provider.',
      line: 8,
      message: 'Rejected-promise reset memoization is reimplemented inline.',
      proof: 'src/gmail/formatter.ts:8 clears the pending promise on rejection, matching the reusable resettable memo in src/shared/async-memo.ts:12.',
      relatedLocations: ['src/shared/async-memo.ts:12'],
      suggestion: 'Use the shared resettable memo implementation and keep retry semantics there.',
    } as const
    const agent: AgentAdapter = async (request) => {
      const subjectSearch = await toolNamed(request, 'search_in_files').execute({ query: 'MAX_SUBJECT_LENGTH' })
      const parserSource = await toolNamed(request, 'read_file').execute({ path: 'src/gmail/parser.ts' })
      const memoSearch = await toolNamed(request, 'search_in_files').execute({ query: 'resettableMemo' })
      const memoSource = await toolNamed(request, 'read_file').execute({ path: 'src/shared/async-memo.ts' })

      expect(subjectSearch).toContain('src/gmail/parser.ts:41: export const MAX_SUBJECT_LENGTH = 998')
      expect(parserSource).toContain('export const MAX_SUBJECT_LENGTH = 998')
      expect(memoSearch).toContain('src/shared/async-memo.ts:12: export function resettableMemo() {}')
      expect(memoSource).toContain('export function resettableMemo() {}')
      expect(await toolNamed(request, 'submit_review').execute({
        findings: [policyFinding, mechanismFinding],
      })).toBe('review submitted')

      return { answer: 'done' }
    }
    const diagnostics: Parameters<RuleContext['report']>[0][] = []
    const context = createContext(cwd, agent, diagnostic => diagnostics.push(diagnostic))

    await duplicatedKnowledgeRule.create(context).onTargetFile?.(createTarget(cwd))

    expect(diagnostics).toEqual([
      {
        evidence: {
          category: 'policy',
          futureFailure: policyFinding.futureFailure,
          proof: policyFinding.proof,
          relatedLocations: policyFinding.relatedLocations,
          suggestion: policyFinding.suggestion,
        },
        filePath: join(cwd, 'src/gmail/formatter.ts'),
        loc: { start: { column: 0, line: 3 } },
        message: policyFinding.message,
      },
      {
        evidence: {
          category: 'mechanism',
          futureFailure: mechanismFinding.futureFailure,
          proof: mechanismFinding.proof,
          relatedLocations: mechanismFinding.relatedLocations,
          suggestion: mechanismFinding.suggestion,
        },
        filePath: join(cwd, 'src/gmail/formatter.ts'),
        loc: { start: { column: 0, line: 8 } },
        message: mechanismFinding.message,
      },
    ])
  })

  it('requests repository evidence with the duplicated-knowledge category contract', async () => {
    let request: AgentRequest | undefined
    const agent: AgentAdapter = async (nextRequest) => {
      request = nextRequest
      await toolNamed(nextRequest, 'submit_review').execute({ findings: [] })

      return { answer: 'done' }
    }

    await duplicatedKnowledgeRule.create(createContext(cwd, agent)).onTargetFile?.(createTarget(cwd))

    expect(request).toBeDefined()
    expect(request?.instructions).toContain(duplicatedKnowledgeInstructions)
    expect(request?.prompt).toContain(duplicatedKnowledgePrompt)
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
              category: { enum: ['policy', 'mechanism'] },
              futureFailure: { minLength: 1, type: 'string' },
              line: { maximum: 10, minimum: 1, type: 'integer' },
              message: { minLength: 1, type: 'string' },
              proof: { minLength: 1, type: 'string' },
              relatedLocations: { minItems: 1, type: 'array' },
              suggestion: { minLength: 1, type: 'string' },
            },
            required: ['category', 'futureFailure', 'line', 'message', 'proof', 'relatedLocations', 'suggestion'],
          },
        },
      },
    })
  })

  it('is non-cacheable and exposes only onTargetFile', () => {
    const handlers = duplicatedKnowledgeRule.create(createContext(cwd, async () => ({ answer: 'unused' })))

    expect(duplicatedKnowledgeRule.cache).toBe(false)
    expect(handlers.onTargetFile).toBeTypeOf('function')
    expect('onTargetClass' in handlers).toBe(false)
    expect('onTargetDirectory' in handlers).toBe(false)
    expect('onTargetFunction' in handlers).toBe(false)
    expect('onTargetProject' in handlers).toBe(false)
    expect('onTargetWith' in handlers).toBe(false)
  })

  it('rejects a finding without futureFailure and fails the review protocol', async () => {
    let rejection: unknown
    const agent: AgentAdapter = async (request) => {
      await toolNamed(request, 'search_in_files').execute({ query: 'MAX_SUBJECT_LENGTH' })
      await toolNamed(request, 'read_file').execute({ path: 'src/gmail/parser.ts' })
      rejection = await toolNamed(request, 'submit_review').execute({
        findings: [{
          category: 'policy',
          line: 3,
          message: 'The subject bound is maintained in two places.',
          proof: 'Both src/gmail/formatter.ts:3 and src/gmail/parser.ts:41 hard-code the same domain bound.',
          relatedLocations: ['src/gmail/parser.ts:41'],
          suggestion: 'Centralize the bound.',
        }],
      })

      return { answer: 'done' }
    }

    await expect(duplicatedKnowledgeRule.create(createContext(cwd, agent)).onTargetFile?.(createTarget(cwd)))
      .rejects
      .toThrow(RepositoryReviewProtocolError)
    expect(rejection).toMatch(/review rejected/i)
  })

  it('rejects empty, malformed, inaccessible, out-of-range, and self-identical related citations', async () => {
    const rejections: unknown[] = []
    const agent: AgentAdapter = async (request) => {
      const submitReview = toolNamed(request, 'submit_review')
      await toolNamed(request, 'search_in_files').execute({ query: 'MAX_SUBJECT_LENGTH' })
      await toolNamed(request, 'read_file').execute({ path: 'src/gmail/parser.ts' })
      const baseFinding = {
        category: 'policy',
        futureFailure: 'Changing only one owner would make runtime behavior diverge.',
        line: 3,
        message: 'The same policy is maintained twice.',
        suggestion: 'Move the policy to a common owner.',
      }

      for (const relatedLocations of [
        [],
        ['src/gmail/parser.ts'],
        ['src/gmail/parser.ts:not-a-line'],
        ['src/gmail/parser.ts:1.5'],
        ['src/gmail/missing.ts:1'],
        ['src/gmail/parser.ts:42'],
        [`${join(cwd, 'src/gmail/parser.ts')}:41`],
        ['../outside.ts:1'],
        ['.env.local:1'],
        ['src/gmail/formatter.ts:3'],
      ]) {
        rejections.push(await submitReview.execute({
          findings: [{
            ...baseFinding,
            proof: `src/gmail/formatter.ts:3 and ${relatedLocations.join(', ')} contain the independent policy definitions.`,
            relatedLocations,
          }],
        }))
      }

      return { answer: 'done' }
    }

    await expect(duplicatedKnowledgeRule.create(createContext(cwd, agent)).onTargetFile?.(createTarget(cwd)))
      .rejects
      .toThrow(RepositoryReviewProtocolError)
    expect(rejections).toHaveLength(10)
    for (const rejection of rejections) {
      expect(rejection).toMatch(/review rejected/i)
    }
  })

  it('accepts an exact repo-relative citation to another valid target line', async () => {
    const agent: AgentAdapter = async (request) => {
      await toolNamed(request, 'search_in_files').execute({ query: 'loadMessage' })
      await toolNamed(request, 'read_file').execute({ path: 'src/gmail/formatter.ts' })
      expect(await toolNamed(request, 'submit_review').execute({
        findings: [{
          category: 'mechanism',
          futureFailure: 'Changing only one inline mechanism would make retry behavior diverge.',
          line: 8,
          message: 'The mechanism is repeated in the target.',
          proof: 'src/gmail/formatter.ts:8 and src/gmail/formatter.ts:7 implement the same mechanism.',
          relatedLocations: ['src/gmail/formatter.ts:7'],
          suggestion: 'Extract one shared mechanism.',
        }],
      })).toBe('review submitted')

      return { answer: 'done' }
    }
    const diagnostics: Parameters<RuleContext['report']>[0][] = []

    await duplicatedKnowledgeRule
      .create(createContext(cwd, agent, diagnostic => diagnostics.push(diagnostic)))
      .onTargetFile?.(createTarget(cwd))

    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0].evidence).toMatchObject({
      relatedLocations: ['src/gmail/formatter.ts:7'],
    })
  })

  it('calibrates shared knowledge, future failures, and suppressions', () => {
    const contract = `${duplicatedKnowledgeInstructions}\n${duplicatedKnowledgePrompt}`

    expect(contract).toMatch(/search.*read.*before report/is)
    expect(contract).toMatch(/before.*empty.*bounded evidence ladder/is)
    expect(contract).toMatch(/constant identifiers.*numeric bounds.*sibling.*validator.*normalizer.*formatter/is)
    expect(contract).toMatch(/hard-coded.*each stage.*not.*common source/is)
    expect(contract).toMatch(/captured promise.*reset.*rejection.*sibling.*client/is)
    expect(contract).toMatch(/do not stop.*first qualifying.*both categories/is)
    expect(contract).toMatch(/captured promise.*whole package.*memo.*catch.*reset.*undefined/is)
    expect(contract).toMatch(/private.*sibling.*plausible common owner/is)
    expect(contract).toMatch(/parser.*tests pass.*serialized.*truncat/is)
    expect(contract).toMatch(/shared responsibility/i)
    expect(contract).toMatch(/common owner/i)
    expect(contract).toMatch(/dependency direction/i)
    expect(contract).toMatch(/asymmetric edit.*divergence.*impact/is)
    expect(contract).toMatch(/coincidental.*literals.*names/is)
    expect(contract).toMatch(/syntactic similarity.*shared knowledge/is)
    expect(contract).toMatch(/defen[cs]e-in-depth.*common source/is)
    expect(contract).toMatch(/distinct trust-boundary policies/i)
    expect(contract).toMatch(/incompatible semantics.*rejection.*cache/is)
    expect(contract).toMatch(/invalid dependency direction/i)
    expect(contract).toContain('simplicity/no-duplicated-helper')
    expect(contract).toMatch(/exact repo-relative path:line/i)
  })
})
