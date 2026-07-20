import type { AgentAdapter, AgentRequest, AgentTool } from '@alint-js/core/agent'
import type { FileTarget, RuleContext } from '@alint-js/plugin'

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { testOnlyProductionWrapperRule } from './rule'

const TARGET_SOURCE = [
  'import { parseGmailMessages } from \'./parser\'',
  '',
  'export const loadGmailMessages = (source: string) => parseGmailMessages(source) ?? []',
].join('\n')

const FINDING = {
  category: 'test-only-production-wrapper',
  futureFailure: 'If undefined becomes an invalid response, tests keep exercising the [] fallback while production uses the direct parser path, so tests pass while production fails.',
  line: 3,
  message: 'loadGmailMessages exists in production but is referenced only by tests.',
  proof: 'test/messages.test.ts:1 is the only external reference; package.json:4 points to src/index.ts, src/index.ts:1 omits it, while src/sync.ts:3 uses parseGmailMessages directly.',
  relatedLocations: ['test/messages.test.ts:1', 'package.json:4', 'src/index.ts:1', 'src/sync.ts:3'],
  suggestion: 'Move the wrapper into the test or make the test exercise syncGmailMessages.',
} as const

function createContext(cwd: string, agent: AgentAdapter, report = vi.fn()): RuleContext {
  return {
    agent,
    cwd,
    id: 'js/no-test-only-production-wrapper',
    localId: 'no-test-only-production-wrapper',
    logger: { debug: () => {} },
    metering: { recordUsage: () => {} },
    model: async () => ({
      aliases: [],
      capabilities: ['tool-call'],
      id: 'model',
      name: 'model',
      params: {},
      provider: { endpoint: '', headers: {}, id: 'provider', type: 'openai-compatible' },
    }),
    options: [],
    report,
    settings: {},
    src: {
      getText: target => target.text,
      readFile: async filePath => ({ language: 'typescript', lines: [], path: filePath, text: '' }),
      sliceLines: (file, range) => ({
        filePath: file.path,
        loc: { end: { column: 0, line: range.endLine }, start: { column: 0, line: range.startLine } },
        text: '',
      }),
      sliceRange: (file, range) => ({
        filePath: file.path,
        loc: { end: { column: range.end, line: 1 }, start: { column: range.start, line: 1 } },
        text: '',
      }),
    },
  }
}

function createTarget(cwd: string): FileTarget {
  const file = {
    language: 'typescript',
    lines: TARGET_SOURCE.split('\n'),
    path: join(cwd, 'src/messages.ts'),
    text: TARGET_SOURCE,
  }
  return { file, identity: 'file:src/messages.ts', kind: 'file', language: file.language, text: file.text }
}

function toolNamed(request: AgentRequest, name: string): AgentTool {
  const tool = request.tools.find(candidate => candidate.name === name)
  if (!tool)
    throw new Error(`Missing tool ${name}`)
  return tool
}

describe('no-test-only-production-wrapper', () => {
  let cwd: string
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'alint-test-wrapper-'))
    cwd = join(root, 'repo')
    await mkdir(join(cwd, 'src'), { recursive: true })
    await mkdir(join(cwd, 'test'), { recursive: true })
    await writeFile(join(cwd, 'package.json'), '{\n  "name": "@acme/gmail",\n  "exports": {\n    ".": "./src/index.ts"\n  }\n}')
    await writeFile(join(cwd, 'src/index.ts'), 'export { syncGmailMessages } from \'./sync\'\n')
    await writeFile(join(cwd, 'src/messages.ts'), TARGET_SOURCE)
    await writeFile(join(cwd, 'src/sync.ts'), 'export function syncGmailMessages(source: string) {\n  const messages = parseGmailMessages(source)\n  return messages\n}\n')
    await writeFile(join(cwd, 'test/messages.test.ts'), 'import { loadGmailMessages } from \'../src/messages\'\n')
  })

  afterEach(async () => rm(root, { force: true, recursive: true }))

  it('reports only after repository discovery and exact supporting reads', async () => {
    const agent: AgentAdapter = async (request) => {
      await toolNamed(request, 'search_in_files').execute({ query: 'loadGmailMessages' })
      for (const path of ['src/messages.ts', 'test/messages.test.ts', 'package.json', 'src/index.ts', 'src/sync.ts']) {
        await toolNamed(request, 'read_file').execute({ path })
      }
      await toolNamed(request, 'submit_review').execute({ findings: [FINDING] })
      return { answer: 'done' }
    }
    const report = vi.fn()

    await testOnlyProductionWrapperRule.create(createContext(cwd, agent, report)).onTargetFile?.(createTarget(cwd))

    expect(report).toHaveBeenCalledWith({
      evidence: {
        category: FINDING.category,
        futureFailure: FINDING.futureFailure,
        proof: FINDING.proof,
        relatedLocations: FINDING.relatedLocations,
        suggestion: FINDING.suggestion,
      },
      filePath: join(cwd, 'src/messages.ts'),
      loc: { start: { column: 0, line: 3 } },
      message: FINDING.message,
    })
  })

  it('requires future failure and at least one related repository location', async () => {
    const agent: AgentAdapter = async (request) => {
      const parameters = toolNamed(request, 'submit_review').parameters as {
        properties: {
          findings: {
            items: {
              properties: { relatedLocations: { minItems: number } }
              required: string[]
            }
          }
        }
      }
      expect(parameters.properties.findings.items.properties.relatedLocations.minItems).toBe(1)
      expect(parameters.properties.findings.items.required).toContain('futureFailure')
      expect(parameters.properties.findings.items.required).toContain('relatedLocations')
      await toolNamed(request, 'submit_review').execute({ findings: [] })
      return { answer: 'done' }
    }

    await testOnlyProductionWrapperRule.create(createContext(cwd, agent)).onTargetFile?.(createTarget(cwd))
  })

  it('propagates repository review failures', async () => {
    const agent: AgentAdapter = async () => {
      throw new Error('agent unavailable')
    }

    await expect(testOnlyProductionWrapperRule.create(createContext(cwd, agent)).onTargetFile?.(createTarget(cwd)))
      .rejects
      .toThrow('agent unavailable')
  })
})
