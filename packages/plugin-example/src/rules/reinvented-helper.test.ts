import type { AgentAdapter, AgentRequest } from '@alint-js/agent'
import type { DiagnosticDescriptor, ResolvedModel, RuleContext, SourceFile, SourceRuntime } from '@alint-js/core'

import type { ReinventedHelperFinding } from './reinvented-helper'

import { describe, expect, it } from 'vitest'

import { createReadFileTool, createReinventedHelperRule, createReportFindingTool } from './reinvented-helper'

function fakeSource(text: string): Pick<SourceRuntime, 'readFile'> {
  return {
    readFile: async (path): Promise<SourceFile> => ({
      language: 'typescript',
      lines: text.split('\n'),
      path,
      text,
    }),
  }
}

describe('read_file tool', () => {
  it('returns the text of the requested file via ctx.src', async () => {
    const tool = createReadFileTool(fakeSource('export const clamp = (n: number) => n'), '/repo')

    const result = await tool.execute({ path: 'src/util.ts' })

    expect(result).toBe('export const clamp = (n: number) => n')
  })

  it('resolves a relative path against cwd before reading', async () => {
    const paths: string[] = []
    const src: Pick<SourceRuntime, 'readFile'> = {
      readFile: async (path) => {
        paths.push(path)

        return fakeFile(path, '')
      },
    }

    const tool = createReadFileTool(src, '/repo')
    await tool.execute({ path: 'src/util.ts' })

    expect(paths).toEqual(['/repo/src/util.ts'])
  })

  it('returns an error string instead of throwing when the file cannot be read', async () => {
    const src: Pick<SourceRuntime, 'readFile'> = {
      readFile: async () => {
        throw new Error('ENOENT: no such file')
      },
    }

    const tool = createReadFileTool(src, '/repo')
    const result = await tool.execute({ path: 'missing.ts' })

    expect(result).toContain('missing.ts')
  })
})

describe('report_finding tool', () => {
  it('records the finding and acknowledges back to the model', async () => {
    const findings: ReinventedHelperFinding[] = []
    const tool = createReportFindingTool(findings)

    const result = await tool.execute({
      line: 12,
      message: 'local clamp duplicates the imported clamp util',
      suggestion: 'import clamp from the shared math util instead',
    })

    expect(findings).toEqual([{
      line: 12,
      message: 'local clamp duplicates the imported clamp util',
      suggestion: 'import clamp from the shared math util instead',
    }])
    expect(result).toContain('recorded')
  })
})

function fakeContext(report: (diagnostic: DiagnosticDescriptor) => void): RuleContext {
  return {
    cwd: '/repo',
    id: 'plugin-example/reinvented-helper',
    localId: 'reinvented-helper',
    logger: { debug: () => {} },
    metering: { recordUsage: () => {} },
    model: async () => fakeModel(),
    report,
    scope: '@alint-js/plugin-example',
    src: { readFile: async path => fakeFile(path, '') } as SourceRuntime,
  }
}

function fakeFile(path: string, text: string): SourceFile {
  return { language: 'typescript', lines: text.split('\n'), path, text }
}

function fakeModel(): ResolvedModel {
  return {
    aliases: [],
    capabilities: [],
    id: 'test-model',
    name: 'Test Model',
    params: {},
    provider: { endpoint: 'http://localhost:11434/v1', headers: {}, id: 'test-provider', type: 'openai-compatible' },
  }
}

describe('reinvented-helper rule', () => {
  it('disables caching and reports each finding the agent records', async () => {
    const reported: DiagnosticDescriptor[] = []
    const requests: AgentRequest[] = []

    const adapter: AgentAdapter = async (request) => {
      requests.push(request)
      const reportTool = request.tools.find(tool => tool.name === 'report_finding')
      await reportTool?.execute({ line: 3, message: 'local clamp duplicates the math util', suggestion: 'import clamp instead' })

      return { answer: 'done' }
    }

    const rule = createReinventedHelperRule(adapter)
    const handlers = rule.create(fakeContext(diagnostic => reported.push(diagnostic)))
    await handlers.onFile?.(fakeFile('src/x.ts', 'a\nb\nexport const clamp = 1'))

    expect(rule.cache).toBe(false)
    expect(requests).toHaveLength(1)
    expect(requests[0].instructions).not.toBe('')
    expect(requests[0].prompt).toContain('src/x.ts')
    expect(requests[0].tools.map(tool => tool.name)).toEqual(['read_file', 'report_finding'])
    expect(reported).toEqual([{
      evidence: { suggestion: 'import clamp instead' },
      filePath: 'src/x.ts',
      loc: { start: { column: 0, line: 3 } },
      message: 'local clamp duplicates the math util',
    }])
  })
})
