import type { AgentAdapter, AgentRequest, AgentTool } from '@alint-js/core/agent'
import type { FileTarget, RuleContext } from '@alint-js/plugin'

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  singleUseMaterializationInstructions,
  singleUseMaterializationPrompt,
  singleUseMaterializationVerificationPrompt,
} from './prompt'
import { singleUseMaterializationRule } from './rule'

const MATERIALIZATION_SOURCE = [
  'export function firstVisible(values: readonly string[]): string | undefined {',
  '  const normalized: string[] = []',
  '  for (const value of values) normalized.push(value.trim())',
  '  for (const value of normalized) {',
  '    if (value.length > 0) return value',
  '  }',
  '}',
].join('\n')

function createContext(cwd: string, agent: AgentAdapter, report: RuleContext['report'] = () => {}): RuleContext {
  return {
    agent,
    cwd,
    id: 'js/no-single-use-materialization',
    localId: 'no-single-use-materialization',
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

function createTarget(cwd: string, source = MATERIALIZATION_SOURCE): FileTarget {
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

describe('no-single-use-materialization', () => {
  let cwd: string
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'alint-no-single-use-materialization-'))
    cwd = join(root, 'repo')
    await mkdir(join(cwd, 'src'), { recursive: true })
    await writeFile(join(cwd, 'src/load.ts'), MATERIALIZATION_SOURCE)
  })

  afterEach(async () => {
    await rm(root, { force: true, recursive: true })
  })

  it('reports a proven fusible materialization', async () => {
    const finding = {
      category: 'single-use-materialization',
      futureFailure: null,
      line: 2,
      message: 'The normalized array is produced once and consumed once immediately.',
      proof: 'The target producer and consumer preserve string order; trim is pure for the declared string inputs, so fusion also avoids later trim calls after the same early return.',
      relatedLocations: [],
      suggestion: 'Normalize each value directly in the consumer loop.',
    } as const
    const agent: AgentAdapter = async (request) => {
      await toolNamed(request, 'search_in_files').execute({ query: 'normalized' })
      await toolNamed(request, 'read_file').execute({ path: 'src/load.ts' })
      await toolNamed(request, 'submit_review').execute({ findings: [finding] })
      return { answer: 'done' }
    }
    const diagnostics: Parameters<RuleContext['report']>[0][] = []

    await singleUseMaterializationRule
      .create(createContext(cwd, agent, diagnostic => diagnostics.push(diagnostic)))
      .onTargetFile?.(createTarget(cwd))

    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({
      evidence: { category: 'single-use-materialization' },
      loc: { start: { line: 2 } },
    })
  })

  it('uses a candidate-focused verifier after a clean first pass', async () => {
    const finding = {
      category: 'single-use-materialization',
      futureFailure: null,
      line: 2,
      message: 'The verifier proved the array and first loop removable.',
      proof: 'The target has one producer and one immediate consumer, and string trim is pure.',
      relatedLocations: [],
      suggestion: 'Fuse the loops.',
    } as const
    const requests: AgentRequest[] = []
    const agent: AgentAdapter = async (request) => {
      requests.push(request)

      if (requests.length === 1) {
        await toolNamed(request, 'submit_review').execute({ findings: [] })
      }
      else {
        await toolNamed(request, 'search_in_files').execute({ query: 'normalized' })
        await toolNamed(request, 'read_file').execute({ path: 'src/load.ts' })
        await toolNamed(request, 'submit_review').execute({ findings: [finding] })
      }

      return { answer: 'done' }
    }

    await singleUseMaterializationRule.create(createContext(cwd, agent)).onTargetFile?.(createTarget(cwd))

    expect(requests).toHaveLength(2)
    expect(requests[0]?.prompt).toContain(singleUseMaterializationPrompt)
    expect(requests[0]?.prompt).toContain('{"line":2,"text":"const normalized: string[] = []"}')
    expect(requests[0]?.prompt).toContain('{"line":3,"text":"for (const value of values) normalized.push(value.trim())"}')
    expect(requests[1]?.prompt).toContain(singleUseMaterializationVerificationPrompt)
  })

  it('defines the focused proof and suppression contract', () => {
    const contract = `${singleUseMaterializationInstructions}\n${singleUseMaterializationPrompt}\n${singleUseMaterializationVerificationPrompt}`

    expect(singleUseMaterializationRule.cache).toBe(false)
    expect(contract).toMatch(/produced once.*consumed once immediately.*fused.*observable behavior/is)
    expect(contract).toMatch(/order.*exception behavior.*evaluation count.*timing.*mutation.*identity.*side effects.*async.*concurrency.*validation ordering.*early exit/is)
    expect(contract).toMatch(/producer loop.*intermediate array.*consumer loop.*early exit/is)
    expect(contract).toMatch(/continue past.*one-expression temporary.*preceding producer loop/is)
    expect(contract).toMatch(/pure.*declared inputs.*skip.*later normalization.*avoids unnecessary work/is)
    expect(contract).toMatch(/snapshots.*sorting.*grouping.*dedupe.*multiple consumers.*named domain phases.*validate-all-before-effects.*batching/is)
    expect(contract).toMatch(/independent pass.*challenge.*declaration.*producer.*consumer.*maximal region/is)
  })

  it('skips files without collection-flow syntax', async () => {
    const agent = vi.fn<AgentAdapter>()
    const source = 'export const identity = <T>(value: T) => value\n'

    await singleUseMaterializationRule.create(createContext(cwd, agent)).onTargetFile?.(createTarget(cwd, source))

    expect(agent).not.toHaveBeenCalled()
  })

  it.each([
    [
      'Array.from plus some',
      'export function any(input: Iterable<string>) {\n  const rows = Array.from(input, value => value.trim())\n  return rows.some(Boolean)\n}\n',
      'Array.from',
      'rows.some',
    ],
    [
      'non-empty literal plus join',
      'export function joined(value: string) {\n  const rows = [value, value.trim()]\n  return rows.join(",")\n}\n',
      '[value, value.trim()]',
      'rows.join',
    ],
    [
      'Set plus has',
      'export function contains(input: readonly string[], value: string) {\n  const values = new Set(input)\n  return values.has(value)\n}\n',
      'new Set',
      'values.has',
    ],
  ])('passes syntax-aware %s candidates to both review passes', async (_label, source, producer, consumer) => {
    const requests: AgentRequest[] = []
    const agent: AgentAdapter = async (request) => {
      requests.push(request)
      await toolNamed(request, 'submit_review').execute({ findings: [] })
      return { answer: 'done' }
    }

    await singleUseMaterializationRule.create(createContext(cwd, agent)).onTargetFile?.(createTarget(cwd, source))

    expect(requests).toHaveLength(2)
    expect(requests[0]?.prompt).toContain(producer)
    expect(requests[0]?.prompt).toContain(consumer)
  })
})
