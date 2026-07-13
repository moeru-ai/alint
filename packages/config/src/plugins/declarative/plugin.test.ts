import { describe, expect, it } from 'vitest'

import { createDeclarativePlugin } from './plugin'

describe('createDeclarativePlugin', () => {
  it('creates plugin rules keyed by declarative rule name', () => {
    const plugin = createDeclarativePlugin({
      rules: [
        {
          builtInAgent: 'basic-structured',
          excludeFiles: [],
          filePath: '/repo/rules/semantic/rule.alint.toml',
          includeFiles: ['src/**/*.py'],
          instruction: 'Find semantic boundary issues.',
          name: 'semantic-boundary',
        },
      ],
    })

    expect(Object.keys(plugin.rules ?? {})).toEqual(['semantic-boundary'])
    expect(plugin.rules?.['semantic-boundary']).toMatchObject({ cache: false })
  })

  it('marks coding-agent rules as not cacheable', () => {
    const plugin = createDeclarativePlugin({
      rules: [
        {
          builtInAgent: 'basic-coding-agent',
          excludeFiles: [],
          filePath: '/repo/rules/reinvented/rule.alint.toml',
          instruction: 'Find reinvented helpers.',
          name: 'reinvented-helper',
        },
      ],
    })

    expect(plugin.rules?.['reinvented-helper']).toMatchObject({ cache: false })
  })
})
