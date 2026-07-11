import { describe, expect, it } from 'vitest'

import { normalizeLoadedAlintConfig } from './static'

describe('normalizeLoadedAlintConfig', () => {
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
