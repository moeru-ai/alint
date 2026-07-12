import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { join } from 'pathe'
import { afterEach, describe, expect, it } from 'vitest'

import { loadPluginLockFile, parsePluginLockFile } from './lock'
import { parsePluginSpecifier } from './spec'

describe('plugin lock parsing', () => {
  it('parses lock entries and finds matching static plugin references', () => {
    const lock = parsePluginLockFile({
      plugins: {
        python: {
          alias: 'python',
          entry: '.alint/plugins/store/@alint-js/plugin-python/0.3.1/package/dist/index.mjs',
          integrity: 'sha512-test',
          name: '@alint-js/plugin-python',
          registry: 'https://registry.npmjs.org/',
          specifier: '@alint-js/plugin-python@0.3.1',
          tarball: 'https://registry.npmjs.org/plugin.tgz',
          version: '0.3.1',
        },
      },
      version: 1,
    }, { cwd: '/repo' })

    const entry = lock.get({
      alias: 'python',
      specifier: parsePluginSpecifier('@alint-js/plugin-python@0.3.1'),
    })

    expect(entry.alias).toBe('python')
    expect(entry.specifier).toEqual(parsePluginSpecifier('@alint-js/plugin-python@0.3.1'))
    expect(entry.lockEntry.entry).toBe('.alint/plugins/store/@alint-js/plugin-python/0.3.1/package/dist/index.mjs')
  })

  it('reports missing lock entries with install guidance', () => {
    const lock = parsePluginLockFile({ plugins: {}, version: 1 }, { cwd: '/repo' })

    expect(() => lock.get({
      alias: 'python',
      specifier: parsePluginSpecifier('@alint-js/plugin-python@0.3.1'),
    })).toThrow('Plugin "python" requires @alint-js/plugin-python@0.3.1, but no matching lock entry exists.')
  })

  it('reports lock specifier mismatches with install guidance', () => {
    const lock = parsePluginLockFile({
      plugins: {
        python: {
          alias: 'python',
          entry: '.alint/plugins/store/@alint-js/plugin-python/0.3.0/package/dist/index.mjs',
          integrity: 'sha512-test',
          name: '@alint-js/plugin-python',
          registry: 'https://registry.npmjs.org/',
          specifier: '@alint-js/plugin-python@0.3.0',
          tarball: 'https://registry.npmjs.org/plugin.tgz',
          version: '0.3.0',
        },
      },
      version: 1,
    }, { cwd: '/repo' })

    expect(() => lock.get({
      alias: 'python',
      specifier: parsePluginSpecifier('@alint-js/plugin-python@0.3.1'),
    })).toThrow('Plugin "python" is locked to @alint-js/plugin-python@0.3.0, but config requires @alint-js/plugin-python@0.3.1.')
  })

  it('rejects lock entries whose record key does not match the entry alias', () => {
    expect(() => parsePluginLockFile({
      plugins: {
        python: {
          alias: 'js',
          entry: '.alint/plugins/store/@alint-js/plugin-python/0.3.1/package/dist/index.mjs',
          integrity: 'sha512-test',
          name: '@alint-js/plugin-python',
          registry: 'https://registry.npmjs.org/',
          specifier: '@alint-js/plugin-python@0.3.1',
          tarball: 'https://registry.npmjs.org/plugin.tgz',
          version: '0.3.1',
        },
      },
      version: 1,
    }, { cwd: '/repo' })).toThrow('Plugin lock entry key "python" must match alias "js".')
  })
})

describe('plugin lock disk loading', () => {
  const tempRoots: string[] = []

  afterEach(async () => {
    await Promise.all(tempRoots.map(root => rm(root, { force: true, recursive: true })))
    tempRoots.length = 0
  })

  async function createTempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'alint-plugin-lock-'))
    tempRoots.push(root)
    return root
  }

  async function writePluginLock(root: string, value: unknown): Promise<void> {
    const lockDir = join(root, '.alint', 'plugins')
    await mkdir(lockDir, { recursive: true })
    await writeFile(join(lockDir, 'lock.json'), JSON.stringify(value), 'utf8')
  }

  it('returns a fresh empty lock when the lock file is missing', async () => {
    const first = await loadPluginLockFile(await createTempRoot())
    const second = await loadPluginLockFile(await createTempRoot())

    first.plugins.python = {
      alias: 'python',
      entry: '.alint/plugins/store/@alint-js/plugin-python/0.3.1/package/dist/index.mjs',
      integrity: 'sha512-test',
      name: '@alint-js/plugin-python',
      registry: 'https://registry.npmjs.org/',
      specifier: '@alint-js/plugin-python@0.3.1',
      tarball: 'https://registry.npmjs.org/plugin.tgz',
      version: '0.3.1',
    }

    expect(first).toEqual({
      plugins: {
        python: {
          alias: 'python',
          entry: '.alint/plugins/store/@alint-js/plugin-python/0.3.1/package/dist/index.mjs',
          integrity: 'sha512-test',
          name: '@alint-js/plugin-python',
          registry: 'https://registry.npmjs.org/',
          specifier: '@alint-js/plugin-python@0.3.1',
          tarball: 'https://registry.npmjs.org/plugin.tgz',
          version: '0.3.1',
        },
      },
      version: 1,
    })
    expect(second).toEqual({ plugins: {}, version: 1 })
  })

  it('loads and validates an existing lock JSON file', async () => {
    const root = await createTempRoot()
    await writePluginLock(root, {
      plugins: {
        python: {
          alias: 'python',
          entry: '.alint/plugins/store/@alint-js/plugin-python/0.3.1/package/dist/index.mjs',
          integrity: 'sha512-test',
          name: '@alint-js/plugin-python',
          registry: 'https://registry.npmjs.org/',
          specifier: '@alint-js/plugin-python@0.3.1',
          tarball: 'https://registry.npmjs.org/plugin.tgz',
          version: '0.3.1',
        },
      },
      version: 1,
    })

    await expect(loadPluginLockFile(root)).resolves.toEqual({
      plugins: {
        python: {
          alias: 'python',
          entry: '.alint/plugins/store/@alint-js/plugin-python/0.3.1/package/dist/index.mjs',
          integrity: 'sha512-test',
          name: '@alint-js/plugin-python',
          registry: 'https://registry.npmjs.org/',
          specifier: '@alint-js/plugin-python@0.3.1',
          tarball: 'https://registry.npmjs.org/plugin.tgz',
          version: '0.3.1',
        },
      },
      version: 1,
    })
  })

  it('rejects malformed lock files', async () => {
    const root = await createTempRoot()
    const lockDir = join(root, '.alint', 'plugins')
    await mkdir(lockDir, { recursive: true })
    await writeFile(join(lockDir, 'lock.json'), '{ "version": 1,', 'utf8')

    await expect(loadPluginLockFile(root)).rejects.toThrow()
  })
})
