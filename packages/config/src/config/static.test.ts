import { describe, expect, it } from 'vitest'

import {
  normalizeLoadedAlintConfig,
  parsePluginSpecifier,
  parseStaticConfig,
  toAlintConfig,
} from './static'

describe('static config parsing', () => {
  it('parses static config groups and extracts string plugin references', () => {
    const config = parseStaticConfig(
      {
        config: {
          group: [
            {
              files: ['**/*.py'],
              plugins: {
                local: { rules: {} },
                python: '@alint-js/plugin-python@0.3.1',
              },
              rules: { 'python/semantic-boundary': 'warn' },
            },
          ],
        },
      },
      { configFile: '/repo/alint.config.toml' },
    )

    expect(config.groups).toHaveLength(1)
    expect(config.groups[0]?.plugins).toEqual([
      {
        alias: 'python',
        specifier: parsePluginSpecifier('@alint-js/plugin-python@0.3.1'),
      },
    ])
    expect(config.groups[0]?.item).toEqual({
      files: ['**/*.py'],
      plugins: {
        local: { rules: {} },
        python: '@alint-js/plugin-python@0.3.1',
      },
      rules: { 'python/semantic-boundary': 'warn' },
    })
  })

  it('rejects repeated static plugin aliases with different specifiers while parsing', () => {
    expect(() => parseStaticConfig(
      {
        config: {
          group: [
            { plugins: { python: '@alint-js/plugin-python@0.3.1' } },
            { plugins: { python: '@alint-js/plugin-python@0.3.2' } },
          ],
        },
      },
      { configFile: '/repo/alint.config.toml' },
    )).toThrow(
      'Static plugin "python" is configured with multiple specifiers: "@alint-js/plugin-python@0.3.1" and "@alint-js/plugin-python@0.3.2".',
    )
  })

  it('resolves parsed static plugin references', async () => {
    const plugin = { rules: {} }
    const config = await toAlintConfig(parseStaticConfig([
      {
        plugins: {
          python: '@alint-js/plugin-python@0.3.1',
        },
      },
    ]), {
      pluginResolver: async () => plugin,
    })

    expect(config).toEqual([
      {
        plugins: {
          python: plugin,
        },
      },
    ])
  })

  it('maps TOML config.group wrapper to flat config items', () => {
    const config = normalizeLoadedAlintConfig(
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

  it('keeps top-level array config as flat config', () => {
    const config = normalizeLoadedAlintConfig(
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

  it('rejects TOML config without config.group', () => {
    expect(() =>
      normalizeLoadedAlintConfig(
        {
          files: ['**/*.py'],
          rules: { 'python/semantic-boundary': 'warn' },
        },
        {
          configFile: '/repo/alint.config.toml',
        },
      ),
    ).toThrow('Static TOML config must use [[config.group]].')
  })

  it('rejects non-array config.group', () => {
    expect(() =>
      normalizeLoadedAlintConfig(
        {
          config: { group: { files: ['**/*.py'] } },
        },
        {
          configFile: '/repo/alint.config.yaml',
        },
      ),
    ).toThrow('Static config field "config.group" must be an array.')
  })
})
