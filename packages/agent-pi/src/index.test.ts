import type { AgentTool } from '@alint-js/agent'
import type { ResolvedModel } from '@alint-js/core'

import { describe, expect, it } from 'vitest'

import { apiKeyFromModel, extractPiText, toPiTools } from './index'

function fakeModel(headers: Record<string, string>): ResolvedModel {
  return {
    aliases: [],
    capabilities: [],
    id: 'gpt-4o-mini',
    name: 'gpt-4o-mini',
    params: {},
    provider: { endpoint: 'https://api.openai.com/v1', headers, id: 'openai', type: 'openai-compatible' },
  }
}

describe('pi adapter helpers', () => {
  it('joins the text parts of an assistant message', () => {
    const text = extractPiText({
      content: [
        { text: 'clampValue ', type: 'text' },
        { text: 'duplicates clamp', type: 'text' },
      ],
      role: 'assistant',
    })

    expect(text).toBe('clampValue duplicates clamp')
  })

  it('translates an AgentTool into a pi tool that wraps the result as text content', async () => {
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

    const [piTool] = toPiTools([agentTool])

    expect(piTool.name).toBe('grep')

    const result = await piTool.execute('call-1', { query: 'clamp' })

    expect(calls).toEqual([{ query: 'clamp' }])
    expect(result.content).toEqual([{ text: 'matches', type: 'text' }])
  })
})

describe('apiKeyFromModel', () => {
  it('extracts the bearer token from the provider Authorization header', () => {
    expect(apiKeyFromModel(fakeModel({ Authorization: 'Bearer sk-test-123' }))).toBe('sk-test-123')
  })

  it('falls back to a placeholder when there is no auth header', () => {
    expect(apiKeyFromModel(fakeModel({}))).toBe('unused')
  })
})
