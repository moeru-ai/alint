import { describe, expect, it } from 'vitest'

import { defineConfig, definePlugin, defineRule } from './index'

describe('@alint-js/plugin helpers', () => {
  it('returns plugin DSL objects unchanged', () => {
    const rule = defineRule({ create: () => ({}) })
    const plugin = definePlugin({ rules: { demo: rule } })
    const input = [{ plugins: { demo: plugin }, rules: { 'demo/demo': 'warn' } }] as const
    const config = defineConfig(input)

    expect(plugin.rules?.demo).toBe(rule)
    expect(config).toBe(input)
  })
})
