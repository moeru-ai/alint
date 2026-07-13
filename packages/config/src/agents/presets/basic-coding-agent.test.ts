import type { AgentTool } from '@alint-js/core/agent'
import type { AgentInput } from 'apeira'

import { describe, expect, it, vi } from 'vitest'

import {
  buildCodingAgentRequest,
  createBasicCodingAgentRule,
  extractAnswer,
  InvalidCodingAgentOutputError,
  parseCodingAgentAnswer,
  recordCodingAgentUsage,
  toRunnerTools,
} from './basic-coding-agent'

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
    expect(request.instructions).toContain('Return only JSON')
    expect(request.prompt).toContain('/repo/src/main.py')
    expect(request.prompt).toContain('1 | def main():')
    expect(request.prompt).toContain('简体中文')
    expect(request.tools).toBe(tools)
  })

  it('parses JSON findings from the final agent answer', () => {
    expect(parseCodingAgentAnswer('{"findings":[{"filePath":"src/main.py","line":1,"message":"move helper"}]}')).toEqual({
      findings: [{ filePath: 'src/main.py', line: 1, message: 'move helper' }],
    })
  })

  it('wraps malformed JSON with a contextual answer preview', () => {
    const answer = `not json ${'x'.repeat(250)}`

    expect(() => parseCodingAgentAnswer(answer)).toThrow(InvalidCodingAgentOutputError)
    expect(() => parseCodingAgentAnswer(answer))
      .toThrow(/Invalid basic-coding-agent JSON response: .+ Answer preview: not json x+/)
    expect(() => parseCodingAgentAnswer(answer)).not.toThrow(answer)
  })

  it('wraps schema-invalid JSON with a contextual answer preview', () => {
    const answer = '{"findings":[{"line":"1","message":"move helper"}]}'

    expect(() => parseCodingAgentAnswer(answer)).toThrow(InvalidCodingAgentOutputError)
    expect(() => parseCodingAgentAnswer(answer))
      .toThrow(/Invalid basic-coding-agent JSON response: .+ Answer preview: \{"findings"/)
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

  it('extracts the latest assistant text from runner output', () => {
    const output = [
      { content: 'first', role: 'assistant', type: 'message' },
      { content: 'question', role: 'user', type: 'message' },
      { content: 'latest', role: 'assistant', type: 'message' },
    ] satisfies AgentInput[]

    expect(extractAnswer(output)).toBe('latest')
  })

  it('returns an empty answer when runner output has no assistant text', () => {
    expect(extractAnswer([{ content: 'question', role: 'user', type: 'message' }])).toBe('')
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
      model: {
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
      },
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
