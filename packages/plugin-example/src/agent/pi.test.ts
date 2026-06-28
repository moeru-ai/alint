import type { AgentTool } from './types'

import { describe, expect, it } from 'vitest'

import { extractPiText, toPiTools } from './pi'

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
