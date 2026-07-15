import { describe, expect, it } from 'vitest'

import { examplePlugin } from './index'

describe('examplePlugin', () => {
  it('exports the recommended example rules', () => {
    const expectedRuleIds = [
      'inline-miniature-normalizer',
      'no-private-schema-toolkit',
      'no-redundant-binding',
      'no-redundant-jsdoc',
      'no-trivial-wrapper-stack',
      'no-vacuous-function',
    ]
    const ruleIds = Object.keys(examplePlugin.rules ?? {})

    expect(ruleIds).toEqual(expectedRuleIds)
    expect(examplePlugin.configs?.recommended).toEqual([
      {
        rules: Object.fromEntries(expectedRuleIds.map(ruleId => [`example/${ruleId}`, 'warn'])),
      },
    ])
  })
})
