import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { loadAlintConfig } from './load'

describe('loadAlintConfig', () => {
  it('loads exported flat config arrays without object defaults', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-config-array-'))
    await writeFile(join(cwd, 'alint.config.ts'), `
export default [
  {
    files: ['**/*.go'],
    rules: { 'review/file': 'warn' },
  },
]
`)

    await mkdir(join(cwd, 'src'))
    const config = await loadAlintConfig(cwd)

    expect(Array.isArray(config)).toBe(true)
    expect(config).toEqual([
      {
        files: ['**/*.go'],
        rules: { 'review/file': 'warn' },
      },
    ])
  })

  it('loads TypeScript-only config syntax through the bundled jiti transform', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-config-ts-transform-'))
    await writeFile(join(cwd, 'alint.config.ts'), `
const config = [
  {
    files: ['**/*.ts'],
    rules: { 'review/typescript': 'warn' },
  },
] satisfies unknown[]

export default config
`)

    const config = await loadAlintConfig(cwd)

    expect(config).toEqual([
      {
        files: ['**/*.ts'],
        rules: { 'review/typescript': 'warn' },
      },
    ])
  })

  it('returns an empty flat config when no config file exists', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-config-missing-'))
    const config = await loadAlintConfig(cwd)

    expect(config).toEqual([])
  })

  it('loads TOML config.group as flat config', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-config-toml-'))
    await writeFile(
      join(cwd, 'alint.config.toml'),
      `
[[config.group]]
name = "python"
files = ["**/*.py"]

[config.group.rules]
"python/semantic-boundary" = "warn"
`,
    )

    const config = await loadAlintConfig(cwd)

    expect(config).toEqual([
      {
        files: ['**/*.py'],
        name: 'python',
        rules: { 'python/semantic-boundary': 'warn' },
      },
    ])
  })

  it('loads JSON wrapper config.group as flat config', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-config-json-'))
    await writeFile(
      join(cwd, 'alint.config.json'),
      JSON.stringify({
        config: {
          group: [
            {
              files: ['**/*.go'],
              rules: { 'go/responsibility-boundary': 'error' },
            },
          ],
        },
      }),
    )

    const config = await loadAlintConfig(cwd)

    expect(config).toEqual([
      {
        files: ['**/*.go'],
        rules: { 'go/responsibility-boundary': 'error' },
      },
    ])
  })

  it('resolves static config plugins through the provided resolver', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-config-static-plugins-'))
    const plugin = { rules: {} }
    await writeFile(
      join(cwd, 'alint.config.toml'),
      `
[[config.group]]
files = ["**/*.py"]

[config.group.plugins]
python = "@alint-js/plugin-python@0.3.1"
`,
    )

    const config = await loadAlintConfig(cwd, undefined, {
      async pluginResolver(reference) {
        expect(reference).toEqual({
          alias: 'python',
          specifier: {
            name: '@alint-js/plugin-python',
            raw: '@alint-js/plugin-python@0.3.1',
            version: '0.3.1',
          },
        })

        return plugin
      },
    })

    expect(config).toEqual([
      {
        files: ['**/*.py'],
        plugins: { python: plugin },
      },
    ])
  })

  it('preserves dynamic TypeScript config plugin objects', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-config-dynamic-plugins-'))
    await writeFile(join(cwd, 'alint.config.ts'), `
const plugin = { rules: {} }

export default [
  {
    files: ['**/*.ts'],
    plugins: { local: plugin },
  },
]
`)

    const config = await loadAlintConfig(cwd)

    expect(config).toEqual([
      {
        files: ['**/*.ts'],
        plugins: { local: { rules: {} } },
      },
    ])
  })
})
