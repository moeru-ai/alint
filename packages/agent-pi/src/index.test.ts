import type { AddressInfo } from 'node:net'

import type { ResolvedModel } from '@alint-js/core'
import type { AgentTool } from '@alint-js/core/agent'

import type { PiAdapterOptions } from './index'

import { createServer } from 'node:http'

import { describe, expect, it } from 'vitest'

import { apiKeyFromModel, createPiAdapter, extractPiText, toPiTools } from './index'

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

describe('pi adapter retry policy', () => {
  it('passes two retries to the Pi provider by default', async () => {
    let capturedMaxRetries: number | undefined
    const adapter = createPiAdapter({
      run: async (_request, maxRetries) => {
        capturedMaxRetries = maxRetries
        return [{ content: 'done', role: 'assistant' }]
      },
    })

    await adapter({
      instructions: 'review',
      model: fakeModel({}),
      prompt: 'inspect this component',
      tools: [],
    })

    expect(capturedMaxRetries).toBe(2)
  })

  it('passes a configured retry budget to Pi', async () => {
    let capturedMaxRetries: number | undefined
    const adapter = createPiAdapter({
      maxRetries: 4,
      run: async (_request, maxRetries) => {
        capturedMaxRetries = maxRetries
        return []
      },
    })

    await adapter({
      instructions: 'review',
      model: fakeModel({}),
      prompt: 'inspect this component',
      tools: [],
    })

    expect(capturedMaxRetries).toBe(4)
  })

  it.each([-1, 1.5])('rejects invalid maxRetries: %s', (maxRetries) => {
    expect(() => createPiAdapter({ maxRetries })).toThrow(TypeError)
  })

  it('keeps maxRetries optional for typed custom runners', () => {
    const options: PiAdapterOptions = {
      run: async () => [],
    }

    expect(createPiAdapter(options)).toBeTypeOf('function')
  })
})

describe('pi adapter cancellation', () => {
  it('rejects with the signal reason when aborted during a provider request', async () => {
    let requestStarted!: () => void
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve
    })
    const server = createServer(() => requestStarted())
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))

    try {
      const controller = new AbortController()
      const reason = new Error('caller stopped the review')
      const model = fakeModel({})
      model.provider.endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
      const result = createPiAdapter({ maxRetries: 0 })({
        instructions: 'review',
        model,
        prompt: 'inspect this component',
        signal: controller.signal,
        tools: [],
      })
      const rejected = expect(result).rejects.toBe(reason)

      await started
      controller.abort(reason)

      await rejected
    }
    finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })

  it('rejects a synchronous setup abort before starting a provider request', async () => {
    let requests = 0
    const server = createServer((_request, response) => {
      requests += 1
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end('data: [DONE]\n\n')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))

    try {
      const controller = new AbortController()
      const reason = new Error('aborted during setup')
      const model = fakeModel({})
      model.provider.endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
      Object.defineProperty(model, 'contextWindow', {
        get: () => {
          controller.abort(reason)
          return 32768
        },
      })

      await expect(createPiAdapter({ maxRetries: 0 })({
        instructions: 'review',
        model,
        prompt: 'inspect this component',
        signal: controller.signal,
        tools: [],
      })).rejects.toBe(reason)
      expect(requests).toBe(0)
    }
    finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })
})
