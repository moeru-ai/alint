import { describe, expect, it } from 'vitest'

import { defineConfig, definePlugin, defineRule } from './define'
import { buildRuleRegistry } from './registry'

describe('rule registry', () => {
  it('enables plugin rules as warn by default', () => {
    const registry = buildRuleRegistry(defineConfig({
      plugins: [
        definePlugin({
          rules: {
            'model-smoke': defineRule({ create: () => ({}) }),
          },
          scope: 'company',
        }),
      ],
    }))

    expect(registry.enabledRules.map(entry => ({
      id: entry.id,
      severity: entry.severity,
    }))).toEqual([
      {
        id: 'company/model-smoke',
        severity: 'warn',
      },
    ])
  })

  it('lets config rules override plugin rule defaults', () => {
    const registry = buildRuleRegistry(defineConfig({
      plugins: [
        definePlugin({
          rules: {
            'off-by-config': defineRule({ create: () => ({}) }),
            'promoted-by-config': defineRule({ create: () => ({}) }),
          },
          scope: 'company',
        }),
      ],
      rules: {
        'company/off-by-config': 'off',
        'company/promoted-by-config': 'error',
      },
    }))

    expect(registry.enabledRules.map(entry => ({
      id: entry.id,
      severity: entry.severity,
    }))).toEqual([
      {
        id: 'company/promoted-by-config',
        severity: 'error',
      },
    ])
  })

  it('registers plugin scoped rule ids', () => {
    const rule = defineRule({
      create: () => ({}),
    })
    const plugin = definePlugin({
      rules: { 'error-handling': rule },
      scope: 'company',
    })
    const registry = buildRuleRegistry(defineConfig({
      plugins: [plugin],
      rules: {
        'company/error-handling': 'warn',
      },
    }))

    expect(registry.enabledRules.map(entry => entry.id)).toEqual(['company/error-handling'])
    expect(registry.enabledRules[0]?.localId).toBe('error-handling')
    expect(registry.enabledRules[0]?.scope).toBe('company')
    expect(registry.enabledRules[0]?.severity).toBe('warn')
  })

  it('rejects duplicate scoped rule ids', () => {
    const rule = defineRule({ create: () => ({}) })
    const pluginA = definePlugin({ rules: { same: rule }, scope: 'company' })
    const pluginB = definePlugin({ rules: { same: rule }, scope: 'company' })

    expect(() => buildRuleRegistry(defineConfig({
      plugins: [pluginA, pluginB],
      rules: {},
    }))).toThrow('Duplicate rule id "company/same".')
  })

  it('preserves npm-scoped plugin names when splitting rule ids', () => {
    const registry = buildRuleRegistry(defineConfig({
      plugins: [
        definePlugin({
          rules: {
            'model-smoke': defineRule({ create: () => ({}) }),
          },
          scope: '@alint-js/plugin-example',
        }),
      ],
      rules: {
        '@alint-js/plugin-example/model-smoke': 'warn',
      },
    }))

    expect(registry.enabledRules[0]).toMatchObject({
      id: '@alint-js/plugin-example/model-smoke',
      localId: 'model-smoke',
      scope: '@alint-js/plugin-example',
    })
  })
})
