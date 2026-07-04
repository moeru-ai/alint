import type { ResolvedModel } from '@alint-js/core'
import type { AgentTool } from '@alint-js/core/agent'
import type { RunnerContext } from 'apeira'

import { describe, expect, it } from 'vitest'

import { createApeiraAdapter } from './index'

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
