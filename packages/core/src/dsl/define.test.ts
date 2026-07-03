import { describe, expect, it } from 'vitest'

import { defineConfig, definePlugin, defineRule } from './define'

describe('define helpers', () => {
  it('keeps flat config arrays unchanged', () => {
    const rule = defineRule({
      create: () => ({
        onTarget: () => {},
      }),
    })
    const plugin = definePlugin({
      rules: {
        review: rule,
      },
    })
    const config = defineConfig([
      {
        files: ['**/*.go'],
        plugins: { demo: plugin },
        rules: { 'demo/review': 'warn' },
      },
    ])

    expect(config).toEqual([
      {
        files: ['**/*.go'],
        plugins: { demo: plugin },
        rules: { 'demo/review': 'warn' },
      },
    ])
  })

  it('does not imply rule enablement from plugin registration', () => {
    const plugin = definePlugin({
      rules: {
        review: defineRule({ create: () => ({ onTarget: () => {} }) }),
      },
    })
    const [item] = defineConfig([{ plugins: { demo: plugin } }])

    expect(item).not.toHaveProperty('rules')
  })
})
