import type { AgentTool } from '@alint-js/core/agent'

import { describe, expect, it } from 'vitest'

import { buildCodingAgentRequest, createCodingAgentRule, parseCodingAgentAnswer } from './coding-agent'

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

  it('creates a non-cacheable rule without requiring ctx.agent', () => {
    const rule = createCodingAgentRule({
      builtInAgent: 'basic-coding-agent',
      excludeFiles: [],
      filePath: '/repo/rules/reinvented/rule.alint.toml',
      instruction: 'Find reinvented helpers.',
      name: 'reinvented-helper',
    })

    expect(rule.cache).toBe(false)
    expect(rule.create).toEqual(expect.any(Function))
  })
})
