import { describe, expect, it } from 'vitest'

import {
  builtInAgentNames,
  declarativeRuleFilePattern,
  isBuiltInAgentName,
} from './types'

describe('declarative rule types', () => {
  it('defines the supported rule file pattern and built-in agents', () => {
    expect(declarativeRuleFilePattern).toBe('**/rule.alint.{toml,yaml,yml,json,jsonc,json5}')
    expect(builtInAgentNames).toEqual(['basic-structured', 'basic-coding-agent'])
    expect(isBuiltInAgentName('basic-structured')).toBe(true)
    expect(isBuiltInAgentName('basic-coding-agent')).toBe(true)
    expect(isBuiltInAgentName('custom-agent')).toBe(false)
  })
})
