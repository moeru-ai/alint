import type { ResolvedModel } from '@alint-js/core'
import type { Runner } from 'apeira'

import { describe, expect, it } from 'vitest'

import { createBasicCodingAgentRule, createCodingAgent } from './basic-coding-agent'

const model: ResolvedModel = {
  aliases: [],
  capabilities: [],
  id: 'test-model',
  name: 'Test Model',
  params: {},
  provider: {
    endpoint: 'https://example.test/v1',
    headers: {},
    id: 'test-provider',
    type: 'openai-compatible',
  },
}

describe('basic-coding-agent declarative preset', () => {
  it('creates a non-cacheable rule without requiring ctx.agent', () => {
    const rule = createBasicCodingAgentRule({
      builtInAgent: 'basic-coding-agent',
      excludeFiles: [],
      filePath: '/repo/rules/reinvented/rule.alint.toml',
      instruction: 'Find reinvented helpers.',
      name: 'reinvented-helper',
    })

    expect(rule.cache).toBe(false)
    expect(rule.create).toEqual(expect.any(Function))
  })

  it('runs with filesystem tools and returns the terminal report', async () => {
    const readCalls: unknown[] = []
    const report = {
      findings: [{ filePath: 'src/main.py', line: 1, message: 'move helper' }],
    }
    const runner: Runner = async (context) => {
      expect(context.instructions).toContain('Find reinvented helpers.')
      expect(context.instructions).toContain('call report_findings')
      expect(context.input).toEqual([
        {
          content: expect.stringContaining('1 | def main():'),
          role: 'user',
          type: 'message',
        },
      ])
      expect(context.tools.map(tool => tool.function.name)).toEqual(['read_file', 'report_findings'])

      const readTool = context.tools.find(tool => tool.function.name === 'read_file')
      const reportTool = context.tools.find(tool => tool.function.name === 'report_findings')
      if (!readTool || !reportTool) {
        throw new Error('Expected coding agent tools')
      }

      await readTool.execute({ path: 'src/utils.py' }, { messages: [], toolCallId: 'call-read' })
      await reportTool.execute(report, { messages: [], toolCallId: 'call-report' })

      return {
        output: [{ content: 'ignored text', role: 'assistant', type: 'message' }],
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      }
    }

    const result = await createCodingAgent(model, runner).run({
      cwd: '/repo',
      instruction: 'Find reinvented helpers.',
      outputLanguage: '简体中文',
      sourceText: 'def main():\n    pass\n',
      targetFilePath: '/repo/src/main.py',
      tools: [
        {
          description: 'Read file',
          execute: (input) => {
            readCalls.push(input)
            return 'contents'
          },
          name: 'read_file',
          parameters: { type: 'object' },
        },
      ],
    })

    expect(readCalls).toEqual([{ path: 'src/utils.py' }])
    expect(result).toEqual({
      findings: report.findings,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    })
  })

  it('rejects invalid report_findings input', async () => {
    const runner: Runner = async (context) => {
      const reportTool = context.tools.find(tool => tool.function.name === 'report_findings')
      if (!reportTool) {
        throw new Error('Expected report_findings tool')
      }

      await reportTool.execute(
        { findings: [{ line: '1', message: 'bad' }] },
        { messages: [], toolCallId: 'call-invalid' },
      )
      return { output: [] }
    }

    await expect(createCodingAgent(model, runner).run({
      cwd: '/repo',
      instruction: 'Review.',
      sourceText: 'const value = 1',
      targetFilePath: '/repo/src/main.ts',
      tools: [],
    })).rejects.toThrow()
  })

  it('rejects a run that stops without report_findings', async () => {
    const runner: Runner = async () => ({ output: [] })

    await expect(createCodingAgent(model, runner).run({
      cwd: '/repo',
      instruction: 'Review.',
      sourceText: 'const value = 1',
      targetFilePath: '/repo/src/main.ts',
      tools: [],
    })).rejects.toThrow('basic-coding-agent stopped without calling report_findings')
  })
})
