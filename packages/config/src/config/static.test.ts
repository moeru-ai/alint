import type { AlintConfigItem } from '@alint-js/core'

import { describe, expect, it } from 'vitest'

import { parsePluginSpecifier } from '../plugins/spec'
import { toAlintConfig } from './static'

function expectConfigItem(value: unknown): asserts value is AlintConfigItem {
  expect(typeof value).toBe('object')
  expect(value).not.toBeNull()
  expect(Array.isArray(value)).toBe(false)
}

describe('toAlintConfig', () => {
  it('maps TOML config.group wrapper to flat config items', async () => {
    const config = await toAlintConfig(
      {
        config: {
          group: [
            {
              files: ['**/*.py'],
              name: 'python',
              rules: { 'python/semantic-boundary': 'warn' },
            },
          ],
        },
      },
      {
        configFile: '/repo/alint.config.toml',
      },
    )

    expect(config).toEqual([
      {
        files: ['**/*.py'],
        name: 'python',
        rules: { 'python/semantic-boundary': 'warn' },
      },
    ])
  })

  it('keeps top-level array config as flat config', async () => {
    const config = await toAlintConfig(
      [
        {
          files: ['**/*.go'],
          rules: { 'go/responsibility-boundary': 'error' },
        },
      ],
      {
        configFile: '/repo/alint.config.json',
      },
    )

    expect(config).toEqual([
      {
        files: ['**/*.go'],
        rules: { 'go/responsibility-boundary': 'error' },
      },
    ])
  })

  it('rejects TOML config without config.group', async () => {
    await expect(
      toAlintConfig(
        {
          files: ['**/*.py'],
          rules: { 'python/semantic-boundary': 'warn' },
        },
        {
          configFile: '/repo/alint.config.toml',
        },
      ),
    ).rejects.toThrow('Static TOML config must use [[config.group]].')
  })

  it('rejects TOML config wrapper without config.group', async () => {
    await expect(
      toAlintConfig(
        {
          config: {},
        },
        {
          configFile: '/repo/alint.config.toml',
        },
      ),
    ).rejects.toThrow('Static TOML config must use [[config.group]].')
  })

  it('returns empty config for nullish values before TOML shape checks', async () => {
    await expect(toAlintConfig(null, {
      configFile: '/repo/alint.config.toml',
    })).resolves.toEqual([])
    await expect(toAlintConfig(undefined, {
      configFile: '/repo/alint.config.toml',
    })).resolves.toEqual([])
  })

  it('rejects non-array config.group', async () => {
    await expect(
      toAlintConfig(
        {
          config: { group: { files: ['**/*.py'] } },
        },
        {
          configFile: '/repo/alint.config.yaml',
        },
      ),
    ).rejects.toThrow('Static config field "config.group" must be an array.')
  })

  it('resolves static plugin specifiers in multiple groups through a resolver', async () => {
    const pythonPlugin = { rules: {} }
    const goPlugin = { rules: {} }
    const references: unknown[] = []

    const config = await toAlintConfig(
      {
        config: {
          group: [
            {
              files: ['**/*.py'],
              plugins: {
                python: '@alint-js/plugin-python@0.3.1',
              },
            },
            {
              files: ['**/*.go'],
              plugins: {
                go: 'alint-plugin-go@1.2.3',
              },
            },
          ],
        },
      },
      {
        configFile: '/repo/alint.config.toml',
        async pluginResolver(reference) {
          references.push(reference)

          return reference.alias === 'python' ? pythonPlugin : goPlugin
        },
      },
    )

    expect(references).toEqual([
      {
        alias: 'python',
        specifier: parsePluginSpecifier('@alint-js/plugin-python@0.3.1'),
      },
      {
        alias: 'go',
        specifier: parsePluginSpecifier('alint-plugin-go@1.2.3'),
      },
    ])
    expect(config).toEqual([
      {
        files: ['**/*.py'],
        plugins: { python: pythonPlugin },
      },
      {
        files: ['**/*.go'],
        plugins: { go: goPlugin },
      },
    ])
  })

  it('rejects static plugin specifiers without a resolver', async () => {
    await expect(
      toAlintConfig(
        {
          config: {
            group: [
              {
                plugins: {
                  python: '@alint-js/plugin-python@0.3.1',
                },
              },
            ],
          },
        },
        {
          configFile: '/repo/alint.config.toml',
        },
      ),
    ).rejects.toThrow('Static plugin "python" requires a plugin resolver.')
  })

  it('propagates static plugin specifier parser errors', async () => {
    await expect(
      toAlintConfig(
        {
          config: {
            group: [
              {
                plugins: {
                  python: '@alint-js/plugin-python@latest',
                },
              },
            ],
          },
        },
        {
          configFile: '/repo/alint.config.toml',
          async pluginResolver() {
            return { rules: {} }
          },
        },
      ),
    ).rejects.toThrow(
      'Static plugin specifier "@alint-js/plugin-python@latest" must use an exact version.',
    )
  })

  it('leaves groups without string plugins unchanged', async () => {
    const plugin = { rules: {} }
    const configItem = {
      files: ['**/*.ts'],
      plugins: {
        local: plugin,
      },
    }

    const config = await toAlintConfig(
      {
        config: {
          group: [configItem],
        },
      },
      {
        configFile: '/repo/alint.config.json',
      },
    )

    expect(config).toEqual([configItem])
  })

  it('reuses repeated static plugin references across groups', async () => {
    const plugin = { rules: {} }
    const references: unknown[] = []

    const config = await toAlintConfig(
      {
        config: {
          group: [
            {
              files: ['src/**/*.py'],
              plugins: {
                python: '@alint-js/plugin-python@0.3.1',
              },
            },
            {
              files: ['test/**/*.py'],
              plugins: {
                python: '@alint-js/plugin-python@0.3.1',
              },
            },
          ],
        },
      },
      {
        configFile: '/repo/alint.config.toml',
        async pluginResolver(reference) {
          references.push(reference)

          return plugin
        },
      },
    )

    expect(references).toEqual([
      {
        alias: 'python',
        specifier: parsePluginSpecifier('@alint-js/plugin-python@0.3.1'),
      },
    ])
    expectConfigItem(config[0])
    expectConfigItem(config[1])
    expect(config[0].plugins?.python).toBe(plugin)
    expect(config[1].plugins?.python).toBe(plugin)
  })

  it('rejects repeated static plugin aliases with different specifiers', async () => {
    await expect(
      toAlintConfig(
        {
          config: {
            group: [
              {
                plugins: {
                  python: '@alint-js/plugin-python@0.3.1',
                },
              },
              {
                plugins: {
                  python: '@alint-js/plugin-python@0.3.2',
                },
              },
            ],
          },
        },
        {
          configFile: '/repo/alint.config.toml',
          async pluginResolver() {
            return { rules: {} }
          },
        },
      ),
    ).rejects.toThrow(
      'Static plugin "python" is configured with multiple specifiers: "@alint-js/plugin-python@0.3.1" and "@alint-js/plugin-python@0.3.2".',
    )
  })
})
