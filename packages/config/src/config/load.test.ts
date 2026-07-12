import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import { loadAlintConfig, loadStaticConfig } from './load'
import { parsePluginSpecifier } from './static'

function createLockEntry(alias: string, specifier: string, entry: string) {
  const name = specifier.slice(0, specifier.lastIndexOf('@'))
  const version = specifier.slice(specifier.lastIndexOf('@') + 1)

  return {
    alias,
    entry,
    integrity: 'sha512-test',
    name,
    registry: 'https://registry.npmjs.org/',
    specifier,
    tarball: 'https://registry.npmjs.org/plugin.tgz',
    version,
  }
}

async function writeInstalledPackage(projectRoot: string): Promise<string> {
  const packageDir = join(projectRoot, '.alint', 'plugins', 'store', '@alint-js', 'plugin-python', '0.3.1', 'package')
  const distDir = join(packageDir, 'dist')
  await mkdir(distDir, { recursive: true })
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({
    exports: { '.': './dist/index.mjs' },
    name: '@alint-js/plugin-python',
    type: 'module',
    version: '0.3.1',
  }), 'utf8')
  await writeFile(join(distDir, 'index.mjs'), 'export default { rules: { "semantic-boundary": {} } }\n', 'utf8')

  return packageDir
}

async function writePluginLock(root: string, plugins: Record<string, unknown>): Promise<void> {
  const lockDir = join(root, '.alint', 'plugins')
  await mkdir(lockDir, { recursive: true })
  await writeFile(join(lockDir, 'lock.json'), JSON.stringify({ plugins, version: 1 }), 'utf8')
}

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

  it('loads configs authored through the CLI facade', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-config-cli-facade-'))
    const cliEntryUrl = pathToFileURL(join(import.meta.dirname, '../../../cli/src/index.ts')).href

    await writeFile(join(cwd, 'alint.config.ts'), `
import { defineConfig, ignorePatternsAIAgents, ignorePatternsCommon } from ${JSON.stringify(cliEntryUrl)}

export default defineConfig([
  {
    name: 'test/global-ignores',
    ignores: [
      ...ignorePatternsCommon,
      ...ignorePatternsAIAgents,
    ],
  },
])
`)

    await mkdir(join(cwd, 'src'))
    const config = await loadAlintConfig(cwd)

    expect(config).toEqual([
      {
        ignores: expect.arrayContaining([
          '**/node_modules/**',
          '**/.agents/**',
        ]),
        name: 'test/global-ignores',
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

  it('loads parsed static plugin references without resolving or importing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-config-static-'))
    await writeFile(join(cwd, 'alint.config.toml'), `
[[config.group]]
name = "python"

[config.group.plugins]
python = "@alint-js/plugin-python@0.3.1"
`)

    const config = await loadStaticConfig(cwd)

    expect(config.groups.flatMap(group => group.plugins)).toEqual([
      {
        alias: 'python',
        specifier: parsePluginSpecifier('@alint-js/plugin-python@0.3.1'),
      },
    ])
    expect(config.groups[0]?.item.plugins?.python).toBe('@alint-js/plugin-python@0.3.1')
  })

  it('reports static plugin references missing from the lock file', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-config-missing-lock-'))
    await writeFile(join(cwd, 'alint.config.toml'), `
[[config.group]]
name = "python"

[config.group.plugins]
python = "@alint-js/plugin-python@0.3.1"
`)

    await expect(loadAlintConfig(cwd))
      .rejects
      .toThrow('Static plugin references are missing from the lock file: python (@alint-js/plugin-python@0.3.1).\nRun: alint plugin install')
  })

  it('reports locked static plugin references whose package cannot be resolved', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-config-unresolved-lock-'))
    await writeFile(join(cwd, 'alint.config.toml'), `
[[config.group]]
name = "python"

[config.group.plugins]
python = "@alint-js/plugin-python@0.3.1"
`)
    await mkdir(join(cwd, '.alint', 'plugins', 'store'), { recursive: true })
    await writePluginLock(cwd, {
      python: createLockEntry(
        'python',
        '@alint-js/plugin-python@0.3.1',
        '.alint/plugins/store/@alint-js/plugin-python/0.3.1/package/dist/index.mjs',
      ),
    })

    await expect(loadAlintConfig(cwd))
      .rejects
      .toThrow('Static plugin packages could not be resolved from the lock file: python (@alint-js/plugin-python@0.3.1).\nRun: alint plugin install')
  })

  it('imports installed locked static plugin packages', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-config-installed-lock-'))
    const packageDir = await writeInstalledPackage(cwd)
    await writeFile(join(cwd, 'alint.config.toml'), `
[[config.group]]
name = "python"

[config.group.plugins]
python = "@alint-js/plugin-python@0.3.1"
`)
    await writePluginLock(cwd, {
      python: createLockEntry(
        'python',
        '@alint-js/plugin-python@0.3.1',
        join(packageDir, 'dist', 'index.mjs'),
      ),
    })

    const config = await loadAlintConfig(cwd)

    expect(config).toEqual([
      {
        name: 'python',
        plugins: {
          python: {
            rules: {
              'semantic-boundary': {},
            },
          },
        },
      },
    ])
  })

  it('loads JS config with plugin objects without a lock file', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-config-plugin-object-'))
    await writeFile(join(cwd, 'alint.config.mjs'), `
export default [
  {
    plugins: {
      local: { rules: { example: {} } },
    },
  },
]
`)

    const config = await loadAlintConfig(cwd)

    expect(config).toEqual([
      {
        plugins: {
          local: {
            rules: {
              example: {},
            },
          },
        },
      },
    ])
  })

  it('loads JS config with plugin objects when the lock file is malformed', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-config-plugin-object-malformed-lock-'))
    await writeFile(join(cwd, 'alint.config.mjs'), `
export default [
  {
    plugins: {
      local: { rules: { example: {} } },
    },
  },
]
`)
    await mkdir(join(cwd, '.alint', 'plugins'), { recursive: true })
    await writeFile(join(cwd, '.alint', 'plugins', 'lock.json'), '{', 'utf8')

    const config = await loadAlintConfig(cwd)

    expect(config).toEqual([
      {
        plugins: {
          local: {
            rules: {
              example: {},
            },
          },
        },
      },
    ])
  })
})
