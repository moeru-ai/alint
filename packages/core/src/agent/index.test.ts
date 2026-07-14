import type { ResolvedModel } from '../models/types'
import type { AgentAdapter, AgentRequest } from './types'

import { describe, expect, it } from 'vitest'

import { requireAgent } from './index'

describe('requireAgent', () => {
  const model: ResolvedModel = {
    aliases: ['default'],
    capabilities: ['structured-output'],
    id: 'local:qwen-8b',
    name: 'qwen:8b',
    params: {},
    provider: {
      endpoint: 'http://localhost:11434/v1',
      headers: {},
      id: 'ollama',
      type: 'openai-compatible',
    },
  }

  function createRequest(overrides: Partial<AgentRequest> = {}): AgentRequest {
    return {
      instructions: 'review',
      model,
      prompt: 'source',
      tools: [],
      ...overrides,
    }
  }

  it('returns an adapter that delegates to the configured one', async () => {
    const received: AgentRequest[] = []
    const adapter: AgentAdapter = async (request) => {
      received.push(request)

      return { answer: 'ok' }
    }

    const result = await requireAgent({ agent: adapter, id: 'company/reinvented-helper' })(createRequest())

    expect(result).toEqual({ answer: 'ok' })
    expect(received).toHaveLength(1)
    expect(received[0]?.prompt).toBe('source')
  })

  it('injects the run signal so rules cancel without opting in', async () => {
    const controller = new AbortController()
    const received: AgentRequest[] = []
    const adapter: AgentAdapter = async (request) => {
      received.push(request)

      return { answer: 'ok' }
    }

    await requireAgent({
      agent: adapter,
      id: 'company/reinvented-helper',
      signal: controller.signal,
    })(createRequest())

    expect(received[0]?.signal).toBe(controller.signal)
  })

  it('keeps a signal the rule passed explicitly', async () => {
    const run = new AbortController()
    const narrow = new AbortController()
    const received: AgentRequest[] = []
    const adapter: AgentAdapter = async (request) => {
      received.push(request)

      return { answer: 'ok' }
    }

    await requireAgent({
      agent: adapter,
      id: 'company/reinvented-helper',
      signal: run.signal,
    })(createRequest({ signal: narrow.signal }))

    expect(received[0]?.signal).toBe(narrow.signal)
  })

  it('leaves the request signal undefined when the run is not cancellable', async () => {
    const received: AgentRequest[] = []
    const adapter: AgentAdapter = async (request) => {
      received.push(request)

      return { answer: 'ok' }
    }

    await requireAgent({ agent: adapter, id: 'company/reinvented-helper' })(createRequest())

    expect(received[0]?.signal).toBeUndefined()
  })

  it('throws a clear, rule-named error when no agent is configured', () => {
    expect(() => requireAgent({ id: 'company/reinvented-helper' }))
      .toThrow(/Rule "company\/reinvented-helper" requires an agent/)
  })

  it('throws a TypeError, since a missing agent is a configuration error', () => {
    expect(() => requireAgent({ agent: undefined, id: 'company/reinvented-helper' })).toThrow(TypeError)
  })
})
