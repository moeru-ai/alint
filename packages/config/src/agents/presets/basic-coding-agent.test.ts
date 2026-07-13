import type { ResolvedModel } from '@alint-js/core'
import type { AgentTool } from '@alint-js/core/agent'
import type { CompletionStep, Runner } from 'apeira'

import { describe, expect, it, vi } from 'vitest'

import {
  buildCodingAgentRequest,
  createBasicCodingAgentRule,
  createCodingAgentRunnerOptions,
  createReportFindingsTool,
  recordCodingAgentUsage,
  reportFindingsToolName,
  runCodingAgent,
  toRunnerTools,
} from './basic-coding-agent'

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

function toolCallStep(toolName: string): CompletionStep {
  return {
    finishReason: 'tool_calls',
    toolCalls: [{ args: '{}', toolCallId: `call-${toolName}`, toolCallType: 'function', toolName }],
    toolResults: [],
  }
}

describe('basic-coding-agent declarative preset', () => {
  it('builds an agent request with fs tools and report instructions', () => {
    const tools: AgentTool[] = [
      {
        description: 'Read file',
        execute: () => '',
        name: 'read_file',
        parameters: { type: 'object' },
      },
    ]

    const request = buildCodingAgentRequest({
      cwd: '/repo',
      instruction: 'Find reinvented helpers.',
      outputLanguage: '简体中文',
      sourceText: 'def main():\n    pass\n',
      targetFilePath: '/repo/src/main.py',
      tools,
    })

    expect(request.instructions).toContain('Find reinvented helpers.')
    expect(request.instructions).toContain('call report_findings')
    expect(request.instructions).not.toContain('Return only JSON')
    expect(request.prompt).toContain('/repo/src/main.py')
    expect(request.prompt).toContain('1 | def main():')
    expect(request.prompt).toContain('简体中文')
    expect(request.tools).toBe(tools)
  })

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

  it('captures validated findings through the terminal report tool', async () => {
    const reports: unknown[] = []
    const tool = createReportFindingsTool(report => reports.push(report))
    const report = {
      findings: [{ filePath: 'src/main.py', line: 1, message: 'move helper' }],
    }

    const result = await tool.execute(report, { messages: [], toolCallId: 'call-report' })

    expect(tool.function.name).toBe(reportFindingsToolName)
    expect(tool.function.strict).toBe(true)
    expect(tool.function.parameters.required).toEqual(['findings'])
    expect(reports).toEqual([report])
    expect(result).toEqual(report)
    await expect(tool.execute({ findings: [{ line: '1', message: 'bad' }] }, { messages: [], toolCallId: 'call-invalid' }))
      .rejects
      .toThrow()
  })

  it('requires tools until report_findings is called or the step limit is reached', () => {
    const options = createCodingAgentRunnerOptions(model)
    const readStep = toolCallStep('read_file')
    const reportStep = toolCallStep(reportFindingsToolName)

    expect(options.toolChoice).toBe('required')
    expect(options.parallelToolCalls).toBe(false)
    expect(options.stopWhen?.({ input: [], step: readStep, steps: [readStep] })).toBe(false)
    expect(options.stopWhen?.({ input: [], step: reportStep, steps: [reportStep] })).toBe(true)
    expect(options.stopWhen?.({ input: [], step: readStep, steps: Array.from({ length: 8 }, () => toolCallStep('read_file')) })).toBe(true)
  })

  it('returns findings submitted through report_findings instead of assistant text', async () => {
    const report = {
      findings: [{ line: 3, message: 'move helper' }],
    }
    const runner: Runner = async (context) => {
      expect(context.tools.map(tool => tool.function.name)).toEqual(['read_file', reportFindingsToolName])

      const reportTool = context.tools.find(tool => tool.function.name === reportFindingsToolName)
      await reportTool?.execute(report, { messages: [], toolCallId: 'call-report' })

      return {
        output: [{ content: 'ignored text', role: 'assistant', type: 'message' }],
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      }
    }

    const result = await runCodingAgent({
      ...buildCodingAgentRequest({
        cwd: '/repo',
        instruction: 'Review.',
        sourceText: 'const value = 1',
        targetFilePath: '/repo/src/main.ts',
        tools: [{ description: 'Read file', execute: () => '', name: 'read_file', parameters: { type: 'object' } }],
      }),
      model,
    }, runner)

    expect(result).toEqual({ findings: report.findings, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } })
  })

  it('rejects a coding-agent run that stops without report_findings', async () => {
    const runner: Runner = async () => ({ output: [] })

    await expect(runCodingAgent({
      ...buildCodingAgentRequest({
        cwd: '/repo',
        instruction: 'Review.',
        sourceText: 'const value = 1',
        targetFilePath: '/repo/src/main.ts',
        tools: [],
      }),
      model,
    }, runner)).rejects.toThrow('basic-coding-agent stopped without calling report_findings')
  })

  it('adapts AgentTool execution for apeira raw tools', async () => {
    const calls: unknown[] = []
    const [tool] = toRunnerTools([
      {
        description: 'Search files',
        execute: (input) => {
          calls.push(input)
          return 'found'
        },
        name: 'search_files',
        parameters: { properties: {}, type: 'object' },
      },
    ])

    const result = await tool.execute({ query: 'helper' }, { messages: [], toolCallId: 'call-1' })

    expect(tool.function.name).toBe('search_files')
    expect(calls).toEqual([{ query: 'helper' }])
    expect(result).toBe('found')
  })

  it('records coding-agent usage with model and operation metadata', () => {
    const recordUsage = vi.fn()

    recordCodingAgentUsage({
      ctx: {
        id: 'declarative/reinvented-helper',
        metering: { recordUsage },
      },
      filePath: '/repo/src/main.py',
      model,
      rule: {
        builtInAgent: 'basic-coding-agent',
        excludeFiles: [],
        filePath: '/repo/rules/reinvented/rule.alint.toml',
        instruction: 'Find reinvented helpers.',
        name: 'reinvented-helper',
      },
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
    })

    expect(recordUsage).toHaveBeenCalledWith({
      filePath: '/repo/src/main.py',
      inputTokens: 10,
      metadata: {
        operation: 'declarative-reinvented-helper-coding-agent',
      },
      modelId: 'test-model',
      outputTokens: 5,
      providerId: 'test-provider',
      ruleId: 'declarative/reinvented-helper',
      totalTokens: 15,
    })
  })
})
