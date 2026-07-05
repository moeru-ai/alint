import type { AgentAdapter } from './types'

import { describe, expect, it } from 'vitest'

import { requireAgent } from './index'

describe('requireAgent', () => {
  it('returns the configured agent adapter', () => {
    const adapter: AgentAdapter = async () => ({ answer: 'ok' })

    expect(requireAgent({ agent: adapter, id: 'company/reinvented-helper' })).toBe(adapter)
  })

  it('throws a clear, rule-named error when no agent is configured', () => {
    expect(() => requireAgent({ id: 'company/reinvented-helper' }))
      .toThrow(/Rule "company\/reinvented-helper" requires an agent/)
  })

  it('throws a TypeError, since a missing agent is a configuration error', () => {
    expect(() => requireAgent({ agent: undefined, id: 'company/reinvented-helper' })).toThrow(TypeError)
  })
})
