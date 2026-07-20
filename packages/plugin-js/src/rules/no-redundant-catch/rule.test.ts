import type { AgentAdapter, AgentRequest, AgentTool } from '@alint-js/core/agent'
import type { FileTarget, RuleContext } from '@alint-js/plugin'

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  redundantCatchInstructions,
  redundantCatchPrompt,
  redundantCatchVerificationPrompt,
} from './prompt'
import { redundantCatchRule } from './rule'

const RETRY_SOURCE = [
  'export class RetryError extends Error {}',
  '',
  'export async function retry<T>(task: () => Promise<T>): Promise<T> {',
  '  try {',
  '    return await task()',
  '  } catch (error) {',
  '    throw error instanceof RetryError',
  '      ? error',
  '      : new RetryError(\'retry exhausted\', { cause: error })',
  '  }',
  '}',
].join('\n')

const REDUNDANT_CATCH_SOURCE = [
  'import { RetryError, retry } from \'./retry\'',
  '',
  'export async function loadProfile() {',
  '  try {',
  '    return await retry(loadRemoteProfile)',
  '  } catch (error) {',
  '    throw error instanceof RetryError',
  '      ? error',
  '      : new RetryError(\'retry exhausted\', { cause: error })',
  '  }',
  '}',
].join('\n')

const METADATA_CATCH_SOURCE = [
  'import { RetryError, retry } from \'./retry\'',
  '',
  'export async function loadProfile() {',
  '  try {',
  '    return await retry(loadRemoteProfile)',
  '  } catch (error) {',
  '    if (error instanceof RetryError) Object.assign(error, { operation: \'loadProfile\' })',
  '    throw error',
  '  }',
  '}',
].join('\n')

function createContext(cwd: string, agent: AgentAdapter, report: RuleContext['report'] = () => {}): RuleContext {
  return {
    agent,
    cwd,
    id: 'js/no-redundant-catch',
    localId: 'no-redundant-catch',
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

function createTarget(cwd: string, source = REDUNDANT_CATCH_SOURCE): FileTarget {
  const file = {
    language: 'typescript',
    lines: source.split('\n'),
    path: join(cwd, 'src/load.ts'),
    text: source,
  }

  return {
    file,
    identity: 'file:src/load.ts',
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

describe('no-redundant-catch', () => {
  let cwd: string
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'alint-no-redundant-catch-'))
    cwd = join(root, 'repo')
    await mkdir(join(cwd, 'src'), { recursive: true })
    await writeFile(join(cwd, 'src/load.ts'), REDUNDANT_CATCH_SOURCE)
    await writeFile(join(cwd, 'src/retry.ts'), RETRY_SOURCE)
  })

  afterEach(async () => {
    await rm(root, { force: true, recursive: true })
  })

  it('reports only after reading and citing the callee error postcondition', async () => {
    const finding = {
      category: 'redundant-catch',
      futureFailure: null,
      line: 4,
      message: 'The catch repeats the RetryError contract already established by retry.',
      proof: 'src/retry.ts:7 shows retry rethrows RetryError identity and wraps every remaining task error. The target repeats the same type, message, and cause mapping, so its non-RetryError arm is unreachable.',
      relatedLocations: ['src/retry.ts:7'],
      suggestion: 'Remove the outer try/catch and return the retry call directly.',
    } as const
    const agent: AgentAdapter = async (request) => {
      const matches = await toolNamed(request, 'search_in_files').execute({ query: 'RetryError' })
      const target = await toolNamed(request, 'read_file').execute({ path: 'src/load.ts' })
      const retry = await toolNamed(request, 'read_file').execute({ path: 'src/retry.ts' })

      expect(matches).toContain('src/load.ts:1')
      expect(target).toContain('return await retry')
      expect(retry).toContain('throw error instanceof RetryError')
      expect(await toolNamed(request, 'submit_review').execute({ findings: [finding] })).toBe('review submitted')

      return { answer: 'done' }
    }
    const diagnostics: Parameters<RuleContext['report']>[0][] = []

    await redundantCatchRule
      .create(createContext(cwd, agent, diagnostic => diagnostics.push(diagnostic)))
      .onTargetFile?.(createTarget(cwd))

    expect(diagnostics).toEqual([{
      evidence: {
        category: finding.category,
        proof: finding.proof,
        relatedLocations: finding.relatedLocations,
        suggestion: finding.suggestion,
      },
      filePath: join(cwd, 'src/load.ts'),
      loc: { start: { column: 0, line: 4 } },
      message: finding.message,
    }])
  })

  it('defines a focused exit-table contract and exact agent wiring', async () => {
    const requests: AgentRequest[] = []
    const agent: AgentAdapter = async (nextRequest) => {
      requests.push(nextRequest)
      await toolNamed(nextRequest, 'submit_review').execute({ findings: [] })
      return { answer: 'done' }
    }

    await redundantCatchRule.create(createContext(cwd, agent)).onTargetFile?.(createTarget(cwd))

    const contract = `${redundantCatchInstructions}\n${redundantCatchPrompt}`
    expect(redundantCatchRule.cache).toBe(false)
    expect(contract).toMatch(/only.*catch blocks.*removable.*protected expression.*same normalized error contract/is)
    expect(contract).toMatch(/every target try\/catch.*search.*read_file.*helper.*domain-error definition/is)
    expect(contract).toMatch(/exit table.*successful return.*domain errors.*callback errors.*delay.*cleanup.*helper internals/is)
    expect(contract).toMatch(/same descriptor.*domain-error identity.*non-domain branch.*unreachable/is)
    expect(contract).toMatch(/do not invent.*Proxy getters.*constructor failures.*Promise rejection/is)
    expect(contract).toMatch(/cleanup.*telemetry.*retry.*rollback.*resource lifecycle.*cause conversion.*metadata conversion/is)
    expect(contract).toMatch(/await.*not a suppression.*actual error exits/is)
    expect(redundantCatchVerificationPrompt).toMatch(/earlier independent pass.*challenge.*every supplied candidate line/is)
    expect(requests).toHaveLength(2)
    expect(requests[0]?.instructions).toContain(redundantCatchInstructions)
    expect(requests[0]?.prompt).toContain(redundantCatchPrompt)
    expect(requests[0]?.prompt).toContain('{"line":4,"text":"try {"}')
    expect(requests[0]?.prompt).toContain('{"line":5,"text":"return await retry(loadRemoteProfile)"}')
    expect(requests[0]?.prompt).toContain('{"line":6,"text":"} catch (error) {"}')
    expect(requests[1]?.prompt).toContain(redundantCatchVerificationPrompt)
    expect(toolNamed(requests[0]!, 'submit_review').parameters).toMatchObject({
      properties: {
        findings: {
          items: {
            properties: {
              category: { enum: ['redundant-catch'] },
              relatedLocations: { minItems: 1 },
            },
          },
        },
      },
    })
  })

  it('rejects a cross-file finding without a related callee citation', async () => {
    let firstAttempt = true
    let rejection: unknown
    const agent: AgentAdapter = async (request) => {
      if (firstAttempt) {
        firstAttempt = false
        await toolNamed(request, 'search_in_files').execute({ query: 'RetryError' })
        await toolNamed(request, 'read_file').execute({ path: 'src/retry.ts' })
        rejection = await toolNamed(request, 'submit_review').execute({
          findings: [{
            category: 'redundant-catch',
            futureFailure: null,
            line: 4,
            message: 'The catch repeats retry.',
            proof: 'The imported helper already normalizes every error.',
            relatedLocations: [],
            suggestion: 'Remove the catch.',
          }],
        })
      }

      await toolNamed(request, 'submit_review').execute({ findings: [] })
      return { answer: 'done' }
    }

    await redundantCatchRule.create(createContext(cwd, agent)).onTargetFile?.(createTarget(cwd))

    expect(rejection).toMatch(/review rejected.*relatedLocations/is)
  })

  it('uses an independent verifier after a clean first pass', async () => {
    const finding = {
      category: 'redundant-catch',
      futureFailure: null,
      line: 4,
      message: 'The verifier proved that the outer catch repeats retry.',
      proof: 'src/retry.ts:7 proves retry already normalizes every error while preserving RetryError identity.',
      relatedLocations: ['src/retry.ts:7'],
      suggestion: 'Remove the outer try/catch.',
    } as const
    let attempt = 0
    const agent: AgentAdapter = async (request) => {
      attempt += 1

      if (attempt === 1) {
        await toolNamed(request, 'submit_review').execute({ findings: [] })
      }
      else {
        await toolNamed(request, 'search_in_files').execute({ query: 'RetryError' })
        await toolNamed(request, 'read_file').execute({ path: 'src/retry.ts' })
        await toolNamed(request, 'submit_review').execute({ findings: [finding] })
      }

      return { answer: 'done' }
    }
    const diagnostics: Parameters<RuleContext['report']>[0][] = []

    await redundantCatchRule
      .create(createContext(cwd, agent, diagnostic => diagnostics.push(diagnostic)))
      .onTargetFile?.(createTarget(cwd))

    expect(attempt).toBe(2)
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]?.message).toBe(finding.message)
  })

  it('skips files without a catch candidate', async () => {
    const agent = vi.fn<AgentAdapter>()
    const source = 'export const identity = <T>(value: T) => value\n'

    await redundantCatchRule.create(createContext(cwd, agent)).onTargetFile?.(createTarget(cwd, source))

    expect(agent).not.toHaveBeenCalled()
  })

  it.each([
    'export const load = () => request.catch(handleError)\n',
    'export const label = "catch"\n',
    '/* catch errors at the boundary */\nexport const value = 1\n',
  ])('skips non-CatchClause source without invoking the agent', async (source) => {
    const agent = vi.fn<AgentAdapter>()

    await redundantCatchRule.create(createContext(cwd, agent)).onTargetFile?.(createTarget(cwd, source))

    expect(agent).not.toHaveBeenCalled()
  })

  it('keeps a catch that adds metadata', async () => {
    await writeFile(join(cwd, 'src/load.ts'), METADATA_CATCH_SOURCE)
    const agent: AgentAdapter = async (request) => {
      await toolNamed(request, 'search_in_files').execute({ query: 'RetryError' })
      await toolNamed(request, 'read_file').execute({ path: 'src/load.ts' })
      await toolNamed(request, 'read_file').execute({ path: 'src/retry.ts' })
      await toolNamed(request, 'submit_review').execute({ findings: [] })
      return { answer: 'done' }
    }
    const diagnostics: Parameters<RuleContext['report']>[0][] = []

    await redundantCatchRule
      .create(createContext(cwd, agent, diagnostic => diagnostics.push(diagnostic)))
      .onTargetFile?.(createTarget(cwd, METADATA_CATCH_SOURCE))

    expect(diagnostics).toEqual([])
  })
})
