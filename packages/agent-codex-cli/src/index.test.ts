import type { AgentRequest } from '@alint-js/core/agent'

import { describe, expect, it } from 'vitest'

import { createCodexCliAdapter } from './index'

function createRequest(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    instructions: 'Review the target.',
    model: {
      aliases: [],
      capabilities: [],
      id: 'gpt-test',
      name: 'GPT Test',
      params: {},
      provider: {
        endpoint: 'https://api.openai.com/v1',
        headers: {},
        id: 'openai',
        type: 'openai-compatible',
      },
    },
    prompt: 'demo.ts\n\nconst value = 1',
    tools: [],
    ...overrides,
  }
}

describe('createCodexCliAdapter', () => {
  it('runs Codex SDK with local Codex configuration by default', async () => {
    const calls: unknown[] = []
    const adapter = createCodexCliAdapter({
      codexPath: 'custom-codex',
      cwd: '/repo',
      run: async (request) => {
        calls.push(request)

        return {
          finalResponse: 'No findings.',
          items: [],
          usage: {
            cached_input_tokens: 0,
            input_tokens: 10,
            output_tokens: 4,
            reasoning_output_tokens: 0,
          },
        }
      },
      sandbox: 'read-only',
    })

    const result = await adapter(createRequest())

    expect(result.answer).toBe('No findings.')
    expect(result.usage?.inputTokens).toBe(10)
    expect(result.usage?.outputTokens).toBe(4)
    expect(result.usage?.totalTokens).toBe(14)
    expect(calls).toEqual([
      {
        codexOptions: {
          codexPathOverride: 'custom-codex',
        },
        input: [
          'Review the target.',
          '',
          'demo.ts',
          '',
          'const value = 1',
        ].join('\n'),
        threadOptions: {
          sandboxMode: 'read-only',
          workingDirectory: '/repo',
        },
        turnOptions: {},
      },
    ])
  })

  it('passes the request model only when explicitly enabled', async () => {
    const adapter = createCodexCliAdapter({
      run: async (request) => {
        expect(request.threadOptions.model).toBe('gpt-test')

        return {
          finalResponse: 'ok',
          items: [],
          usage: null,
        }
      },
      useRequestModel: true,
    })

    await expect(adapter(createRequest())).resolves.toEqual({ answer: 'ok', usage: undefined })
  })

  it('passes the request signal to the Codex turn', async () => {
    const controller = new AbortController()
    const adapter = createCodexCliAdapter({
      run: async (request) => {
        expect(request.turnOptions.signal).toBe(controller.signal)

        return { finalResponse: 'ok', items: [], usage: null }
      },
    })

    await adapter(createRequest({ signal: controller.signal }))
  })

  it('rejects alint tools because Codex CLI uses its own tool runtime', async () => {
    const adapter = createCodexCliAdapter({
      run: async () => {
        throw new Error('should not run')
      },
    })

    await expect(adapter(createRequest({
      tools: [
        {
          description: 'Read a file',
          execute: () => 'file',
          name: 'read_file',
          parameters: { type: 'object' },
        },
      ],
    }))).rejects.toThrow(/does not support alint AgentTool callbacks/)
  })
})
