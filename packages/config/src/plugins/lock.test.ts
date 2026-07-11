import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { emptyPluginLockFile, loadPluginLockFile, writePluginLockFile } from './lock'
import { getProjectPluginLockPath, getProjectPluginStoreDir, getStoredPluginPackageDir } from './paths'

describe('plugin lock files', () => {
  it('resolves project plugin paths under .alint/plugins', () => {
    expect(getProjectPluginStoreDir('/repo')).toBe(join('/repo', '.alint', 'plugins', 'store'))
    expect(getProjectPluginLockPath('/repo')).toBe(join('/repo', '.alint', 'plugins', 'lock.json'))
    expect(getStoredPluginPackageDir('/repo', '@alint-js/plugin-python', '0.3.1')).toBe(join(
      '/repo',
      '.alint',
      'plugins',
      'store',
      '@alint-js',
      'plugin-python',
      '0.3.1',
      'package',
    ))
  })

  it('rejects stored package names that can escape the plugin store', () => {
    for (const name of [
      '../outside',
      '../../outside',
      '@scope/../outside',
      '@scope/',
      'scope/package',
      'plugin\\outside',
    ]) {
      expect(() => getStoredPluginPackageDir('/repo', name, '1.2.3')).toThrow(
        `Invalid plugin package name "${name}".`,
      )
    }
  })

  it('rejects stored package versions that can escape the plugin store', () => {
    for (const version of [
      '',
      '.',
      '..',
      '../outside',
      '../../outside',
      '1.2.3/../../outside',
      '1.2.3\\outside',
    ]) {
      expect(() => getStoredPluginPackageDir('/repo', '@alint-js/plugin-python', version)).toThrow(
        `Invalid plugin package version "${version}".`,
      )
    }
  })

  it('returns an empty lock when no lock file exists', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-plugin-lock-'))

    await expect(loadPluginLockFile(cwd)).resolves.toEqual(emptyPluginLockFile())
  })

  it('round-trips lock files', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-plugin-lock-'))
    const lock = emptyPluginLockFile()
    lock.plugins.python = {
      alias: 'python',
      apiVersion: '1',
      entry: '.alint/plugins/store/@alint-js/plugin-python/0.3.1/package/dist/index.mjs',
      integrity: 'sha512-test',
      name: '@alint-js/plugin-python',
      registry: 'https://registry.npmjs.org/',
      specifier: '@alint-js/plugin-python@0.3.1',
      tarball: 'https://registry.npmjs.org/@alint-js/plugin-python/-/plugin-python-0.3.1.tgz',
      version: '0.3.1',
    }

    await mkdir(join(cwd, '.alint'), { recursive: true })
    await writePluginLockFile(cwd, lock)

    await expect(loadPluginLockFile(cwd)).resolves.toEqual(lock)
    await expect(readFile(getProjectPluginLockPath(cwd), 'utf8')).resolves.toBe(`${JSON.stringify(lock, null, 2)}\n`)
  })

  it('rejects unsupported lock file versions', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-plugin-lock-'))
    await mkdir(join(cwd, '.alint', 'plugins'), { recursive: true })
    await writeFile(getProjectPluginLockPath(cwd), JSON.stringify({
      plugins: {},
      version: 2,
    }))

    await expect(loadPluginLockFile(cwd)).rejects.toThrow()
  })

  it('rejects malformed lock file entries', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-plugin-lock-'))
    await mkdir(join(cwd, '.alint', 'plugins'), { recursive: true })
    await writeFile(getProjectPluginLockPath(cwd), JSON.stringify({
      plugins: {
        python: {
          alias: 'python',
          version: '0.3.1',
        },
      },
      version: 1,
    }))

    await expect(loadPluginLockFile(cwd)).rejects.toThrow()
  })
})
