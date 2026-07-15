import { describe, expect, it } from 'vitest'

import { resolveRunnerConfig } from './runner'

describe('resolveRunnerConfig', () => {
  it('lets project config override setup agent retries', () => {
    expect(resolveRunnerConfig(
      { providers: [], runner: { agentRetries: 1 }, version: 1 },
      { runner: { agentRetries: 4 } },
      { format: 'stylish' },
    )?.agentRetries).toBe(4)
  })
})
