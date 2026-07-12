import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { join } from 'pathe'
import { afterEach, describe, expect, it } from 'vitest'

import { parseStaticConfig } from '../config/static'
import { listMissing, listUnresolved, loadPluginLockFile, parsePluginLockFile, writePluginLockFile } from './lock'
import { parsePluginSpecifier } from './spec'

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

  it('rejects lock entries with unsupported npm integrity format', () => {
    expect(() => parsePluginLockFile({
      plugins: {
        python: {
          alias: 'python',
          entry: '.alint/plugins/store/@alint-js/plugin-python/0.3.1/package/dist/index.mjs',
          integrity: 'sha1-deadbeef',
          name: '@alint-js/plugin-python',
          registry: 'https://registry.npmjs.org/',
          specifier: '@alint-js/plugin-python@0.3.1',
          tarball: 'https://registry.npmjs.org/plugin.tgz',
          version: '0.3.1',
        },
      },
      version: 1,
    }, { cwd: '/repo' })).toThrow('Unsupported npm integrity format for "@alint-js/plugin-python@0.3.1": "sha1-deadbeef".')
  })
})

describe('plugin lock static config state', () => {
  const tempRoots: string[] = []

  afterEach(async () => {
    await Promise.all(tempRoots.map(root => rm(root, { force: true, recursive: true })))
    tempRoots.length = 0
  })

  async function createTempProject(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'alint-plugin-lock-state-'))
    tempRoots.push(root)
    return root
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
    await writeFile(join(distDir, 'index.mjs'), 'export default { rules: {} }\n', 'utf8')

    return packageDir
  }

  it('returns static plugin references absent from the lock file', () => {
    const config = parseStaticConfig([
      { plugins: { python: '@alint-js/plugin-python@0.3.1' } },
      { plugins: { js: '@alint-js/plugin-js@1.2.3' } },
    ])
    const lock = parsePluginLockFile({
      plugins: {
        python: createLockEntry(
          'python',
          '@alint-js/plugin-python@0.3.1',
          '.alint/plugins/store/@alint-js/plugin-python/0.3.1/package/dist/index.mjs',
        ),
      },
      version: 1,
    }, { cwd: '/repo' })

    expect(listMissing(config, lock)).toEqual([
      {
        alias: 'js',
        specifier: parsePluginSpecifier('@alint-js/plugin-js@1.2.3'),
      },
    ])
  })

  it('returns mismatched-version static plugin references as missing', () => {
    const config = parseStaticConfig([
      { plugins: { python: '@alint-js/plugin-python@0.3.1' } },
    ])
    const lock = parsePluginLockFile({
      plugins: {
        python: createLockEntry(
          'python',
          '@alint-js/plugin-python@0.3.0',
          '.alint/plugins/store/@alint-js/plugin-python/0.3.0/package/dist/index.mjs',
        ),
      },
      version: 1,
    }, { cwd: '/repo' })

    expect(listMissing(config, lock)).toEqual([
      {
        alias: 'python',
        specifier: parsePluginSpecifier('@alint-js/plugin-python@0.3.1'),
      },
    ])
  })

  it('returns lock entries whose package entry cannot be resolved', async () => {
    const projectRoot = await createTempProject()
    await mkdir(join(projectRoot, '.alint', 'plugins', 'store'), { recursive: true })
    const config = parseStaticConfig([
      { plugins: { python: '@alint-js/plugin-python@0.3.1' } },
      { plugins: { python: '@alint-js/plugin-python@0.3.1' } },
    ])
    const lock = parsePluginLockFile({
      plugins: {
        python: createLockEntry(
          'python',
          '@alint-js/plugin-python@0.3.1',
          '.alint/plugins/store/@alint-js/plugin-python/0.3.1/package/dist/index.mjs',
        ),
      },
      version: 1,
    }, { cwd: projectRoot })

    const unresolved = await listUnresolved(config, lock)

    expect(unresolved).toHaveLength(1)
    expect(unresolved[0]?.alias).toBe('python')
    expect(unresolved[0]?.lockEntry.entry).toBe('.alint/plugins/store/@alint-js/plugin-python/0.3.1/package/dist/index.mjs')
  })

  it('ignores static plugin references missing from the lock file when listing unresolved entries', async () => {
    const config = parseStaticConfig([
      { plugins: { python: '@alint-js/plugin-python@0.3.1' } },
    ])
    const lock = parsePluginLockFile({ plugins: {}, version: 1 }, { cwd: await createTempProject() })

    await expect(listUnresolved(config, lock)).resolves.toEqual([])
  })

  it('returns no unresolved entries for an installed package entry', async () => {
    const projectRoot = await createTempProject()
    const packageDir = await writeInstalledPackage(projectRoot)
    const config = parseStaticConfig([
      { plugins: { python: '@alint-js/plugin-python@0.3.1' } },
    ])
    const lock = parsePluginLockFile({
      plugins: {
        python: createLockEntry(
          'python',
          '@alint-js/plugin-python@0.3.1',
          join(packageDir, 'dist', 'index.mjs'),
        ),
      },
      version: 1,
    }, { cwd: projectRoot })

    await expect(listUnresolved(config, lock)).resolves.toEqual([])
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

  it('keeps an existing lock file when the replacement lock fails validation', async () => {
    const root = await createTempRoot()
    const lockPath = join(root, '.alint', 'plugins', 'lock.json')
    await writePluginLock(root, {
      plugins: {
        python: createLockEntry(
          'python',
          '@alint-js/plugin-python@0.3.1',
          '.alint/plugins/store/@alint-js/plugin-python/0.3.1/package/dist/index.mjs',
        ),
      },
      version: 1,
    })
    const originalLock = await readFile(lockPath, 'utf8')

    await expect(writePluginLockFile(root, {
      plugins: {
        python: {
          ...createLockEntry(
            'javascript',
            '@alint-js/plugin-js@1.2.3',
            '.alint/plugins/store/@alint-js/plugin-js/1.2.3/package/dist/index.mjs',
          ),
        },
      },
      version: 1,
    })).rejects.toThrow('Plugin lock entry key "python" must match alias "javascript".')
    await expect(readFile(lockPath, 'utf8')).resolves.toBe(originalLock)
  })
})
