import { describe, expect, it } from 'vitest'

import * as pluginJs from './index'

describe('examplePlugin', () => {
  it('exports the recommended example rules', () => {
    const expectedRuleIds = [
      'inline-miniature-normalizer',
      'no-mixed-layers-without-abstraction',
      'no-private-schema-toolkit',
      'no-redundant-binding',
      'no-redundant-jsdoc',
      'no-trivial-wrapper-stack',
      'no-vacuous-function',
    ]
    const ruleIds = Object.keys(pluginJs.examplePlugin.rules ?? {})

    expect(ruleIds).toEqual(expectedRuleIds)
    expect(pluginJs.examplePlugin.configs?.recommended).toEqual([
      {
        rules: Object.fromEntries(expectedRuleIds.map(ruleId => [`example/${ruleId}`, 'warn'])),
      },
    ])
  })

  it('keeps rule-construction test seams out of the public package API', () => {
    expect(pluginJs).not.toHaveProperty('createMixedLayersWithoutAbstractionRule')
  })
})
