import type { ResolvedModel } from '@alint-js/core'
import type { AgentTool } from '@alint-js/core/agent'
import type { RunnerContext } from 'apeira'

import { describe, expect, it } from 'vitest'

import { createApeiraAdapter, toRunnerTools } from './index'

function fakeModel(): ResolvedModel {
  return {
    aliases: [],
    capabilities: [],
    id: 'test-model',
    name: 'Test Model',
    params: {},
    provider: {
      endpoint: 'http://localhost:11434/v1',
      headers: {},
      id: 'test-provider',
      type: 'openai-compatible',
    },
  }
}

describe('apeira adapter', () => {
  it.each([0, -1, 1.5])('rejects an invalid maximum step count: %s', (maxSteps) => {
    expect(() => createApeiraAdapter({ maxSteps })).toThrow(TypeError)
  })

  it('passes the configured maximum step count to the runner factory', async () => {
    let capturedMaxSteps: number | undefined
    const adapter = createApeiraAdapter({
      createRunner: (_model, maxSteps) => {
        capturedMaxSteps = maxSteps

        return async () => ({
          output: [{ content: 'done', role: 'assistant', type: 'message' }],
          usage: undefined,
        })
      },
      maxSteps: 24,
    })

    await adapter({
      instructions: 'inspect the component',
      model: fakeModel(),
      prompt: 'review architectural boundaries',
      tools: [],
    })

    expect(capturedMaxSteps).toBe(24)
  })

  it('retries a transient provider request without replaying the runner', async () => {
    const controller = new AbortController()
    let captured: RunnerContext | undefined
    let providerCalls = 0
    let runnerCalls = 0

    const adapter = createApeiraAdapter({
      createRunner: (_model, _maxSteps, fetch) => async (context) => {
        runnerCalls += 1
        captured = context

        const response = await fetch('https://example.com/v1/chat/completions', {
          signal: context.abortSignal,
        })
        expect(response.status).toBe(200)

        return {
          output: [{ content: 'done', role: 'assistant', type: 'message' }],
          usage: undefined,
        }
      },
      fetch: async () => {
        providerCalls += 1
        return new Response(undefined, { status: providerCalls === 1 ? 500 : 200 })
      },
      retryPolicy: { maxRetries: 2, retryDelay: () => 0 },
    })

    await adapter({
      instructions: 'inspect the component',
      model: fakeModel(),
      prompt: 'review architectural boundaries',
      signal: controller.signal,
      tools: [],
    })

    expect(providerCalls).toBe(2)
    expect(runnerCalls).toBe(1)
    expect(captured?.abortSignal).toBe(controller.signal)
  })

  it('returns the final assistant message as the answer', async () => {
    const adapter = createApeiraAdapter({
      createRunner: () => async () => ({
        output: [{ content: 'dup of clamp()', role: 'assistant', type: 'message' }],
        usage: undefined,
      }),
    })

    const result = await adapter({
      instructions: 'system prompt',
      model: fakeModel(),
      prompt: 'find duplicate helpers',
      tools: [],
    })

    expect(result.answer).toBe('dup of clamp()')
  })

  it('maps the runner usage onto the result', async () => {
    const adapter = createApeiraAdapter({
      createRunner: () => async () => ({
        output: [{ content: 'done', role: 'assistant', type: 'message' }],
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      }),
    })

    const result = await adapter({
      instructions: 'system prompt',
      model: fakeModel(),
      prompt: 'find duplicate helpers',
      tools: [],
    })

    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 })
  })

  it('passes instructions, prompt, and translated tools to the runner', async () => {
    let captured: RunnerContext | undefined

    const grepTool: AgentTool = {
      description: 'search the repo',
      execute: () => 'matches',
      name: 'grep',
      parameters: { properties: {}, type: 'object' },
    }

    const adapter = createApeiraAdapter({
      createRunner: () => async (context) => {
        captured = context
        return { output: [{ content: 'ok', role: 'assistant', type: 'message' }], usage: undefined }
      },
    })

    await adapter({
      instructions: 'be careful',
      model: fakeModel(),
      prompt: 'find duplicates',
      tools: [grepTool],
    })

    expect(captured?.instructions).toBe('be careful')
    expect(JSON.stringify(captured?.input)).toContain('find duplicates')
    expect(captured?.tools.map(tool => tool.function.name)).toEqual(['grep'])
  })
})

describe('apeira tool translation', () => {
  it('runs the underlying AgentTool.execute and returns its result', async () => {
    const calls: unknown[] = []
    const agentTool: AgentTool = {
      description: 'search the repo',
      execute: (input) => {
        calls.push(input)

        return 'matches'
      },
      name: 'grep',
      parameters: { properties: {}, type: 'object' },
    }

    const [runnerTool] = toRunnerTools([agentTool])

    expect(runnerTool.function.name).toBe('grep')

    const result = await runnerTool.execute({ query: 'clamp' }, { messages: [], toolCallId: 'call-1' })

    expect(calls).toEqual([{ query: 'clamp' }])
    expect(result).toBe('matches')
  })

  it('coerces an undefined tool result to an empty string', async () => {
    const agentTool: AgentTool = {
      description: 'record a finding',
      execute: () => undefined,
      name: 'report_finding',
      parameters: { properties: {}, type: 'object' },
    }

    const [runnerTool] = toRunnerTools([agentTool])
    const result = await runnerTool.execute({}, { messages: [], toolCallId: 'call-1' })

    expect(result).toBe('')
  })
})
