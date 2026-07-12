import type { ParsedPluginLockEntry } from './types'

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { join } from 'pathe'
import { afterEach, describe, expect, it } from 'vitest'

import {
  importResolvedPluginPackage,
  resolveInstalledPackageEntry,
  resolveInstalledPackageRelativeEntry,
  resolveLockedPluginPackage,
} from './package'
import { parsePluginSpecifier } from './spec'

describe('plugin package resolution', () => {
  const tempRoots: string[] = []

  afterEach(async () => {
    await Promise.all(tempRoots.map(root => rm(root, { force: true, recursive: true })))
    tempRoots.length = 0
  })

  async function createTempProject(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'alint-plugin-package-'))
    tempRoots.push(root)
    return root
  }

  function createLockEntry(cwd: string, entry: string): ParsedPluginLockEntry {
    return {
      alias: 'python',
      cwd,
      lockEntry: {
        alias: 'python',
        entry,
        integrity: 'sha512-test',
        name: '@alint-js/plugin-python',
        registry: 'https://registry.npmjs.org/',
        specifier: '@alint-js/plugin-python@0.3.1',
        tarball: 'https://registry.npmjs.org/plugin.tgz',
        version: '0.3.1',
      },
      specifier: parsePluginSpecifier('@alint-js/plugin-python@0.3.1'),
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
    await writeFile(join(distDir, 'index.mjs'), 'export default { rules: {} }\n', 'utf8')

    return packageDir
  }

  it('resolves and imports a locked package entry from the plugin store', async () => {
    const projectRoot = await createTempProject()
    const packageDir = await writeInstalledPackage(projectRoot)

    const resolved = await resolveLockedPluginPackage(createLockEntry(
      projectRoot,
      '.alint/plugins/store/@alint-js/plugin-python/0.3.1/package/dist/index.mjs',
    ))
    const plugin = await importResolvedPluginPackage(resolved)

    expect(resolved.entry).toBe(join(packageDir, 'dist', 'index.mjs'))
    expect(resolved.packageDir).toBe(packageDir)
    expect(resolved.packageJson).toMatchObject({
      name: '@alint-js/plugin-python',
      version: '0.3.1',
    })
    expect(plugin).toEqual({ rules: {} })
  })

  it('resolves a locked package entry when its export path contains a package directory', async () => {
    const projectRoot = await createTempProject()
    const packageDir = join(projectRoot, '.alint', 'plugins', 'store', '@alint-js', 'plugin-python', '0.3.1', 'package')
    const distPackageDir = join(packageDir, 'dist', 'package')
    await mkdir(distPackageDir, { recursive: true })
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({
      exports: { '.': './dist/package/index.mjs' },
      name: '@alint-js/plugin-python',
      type: 'module',
      version: '0.3.1',
    }), 'utf8')
    await writeFile(join(distPackageDir, 'index.mjs'), 'export default { rules: {} }\n', 'utf8')

    const resolved = await resolveLockedPluginPackage(createLockEntry(
      projectRoot,
      '.alint/plugins/store/@alint-js/plugin-python/0.3.1/package/dist/package/index.mjs',
    ))
    const plugin = await importResolvedPluginPackage(resolved)

    expect(resolved.entry).toBe(join(distPackageDir, 'index.mjs'))
    expect(resolved.packageDir).toBe(packageDir)
    expect(resolved.packageJson).toMatchObject({
      name: '@alint-js/plugin-python',
      version: '0.3.1',
    })
    expect(plugin).toEqual({ rules: {} })
  })

  it('rejects a lock entry that escapes the project root', async () => {
    const projectRoot = await createTempProject()

    await expect(resolveLockedPluginPackage(createLockEntry(projectRoot, '../outside/index.mjs')))
      .rejects
      .toThrow('Plugin lock entry "python" resolves outside the project root.')
  })

  it('rejects a lock entry that escapes through a symlink', async () => {
    const projectRoot = await createTempProject()
    const outsideRoot = await createTempProject()
    const linkPath = join(projectRoot, '.alint', 'plugins', 'store', 'linked')
    await mkdir(join(projectRoot, '.alint', 'plugins', 'store'), { recursive: true })
    await symlink(outsideRoot, linkPath, 'dir')

    await expect(resolveLockedPluginPackage(createLockEntry(projectRoot, '.alint/plugins/store/linked/package/dist/index.mjs')))
      .rejects
      .toThrow('Plugin lock entry "python" resolves outside the plugin store.')
  })

  it('rejects a lock entry that escapes the locked package through a store symlink', async () => {
    const projectRoot = await createTempProject()
    const pythonPackageDir = await writeInstalledPackage(projectRoot)
    const otherPackageDir = join(projectRoot, '.alint', 'plugins', 'store', '@alint-js', 'plugin-other', '1.0.0', 'package')
    const otherDistDir = join(otherPackageDir, 'dist')

    await rm(pythonPackageDir, { force: true, recursive: true })
    await mkdir(otherDistDir, { recursive: true })
    await writeFile(join(otherPackageDir, 'package.json'), JSON.stringify({
      exports: { '.': './dist/index.mjs' },
      name: '@alint-js/plugin-other',
      type: 'module',
      version: '1.0.0',
    }), 'utf8')
    await writeFile(join(otherDistDir, 'index.mjs'), 'export default { rules: {} }\n', 'utf8')
    await symlink(otherPackageDir, pythonPackageDir, 'dir')

    await expect(resolveLockedPluginPackage(createLockEntry(
      projectRoot,
      '.alint/plugins/store/@alint-js/plugin-python/0.3.1/package/dist/index.mjs',
    )))
      .rejects
      .toThrow('Plugin lock entry "python" resolves outside the locked package directory.')
  })

  it('rejects a lock entry inside the plugins directory but outside the plugin store', async () => {
    const projectRoot = await createTempProject()
    const packageDir = join(projectRoot, '.alint', 'plugins', 'other', 'package')
    const distDir = join(packageDir, 'dist')
    await mkdir(join(projectRoot, '.alint', 'plugins', 'store'), { recursive: true })
    await mkdir(distDir, { recursive: true })
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({
      name: '@alint-js/plugin-python',
      type: 'module',
      version: '0.3.1',
    }), 'utf8')
    await writeFile(join(distDir, 'index.mjs'), 'export default { rules: {} }\n', 'utf8')

    await expect(resolveLockedPluginPackage(createLockEntry(
      projectRoot,
      '.alint/plugins/other/package/dist/index.mjs',
    )))
      .rejects
      .toThrow('Plugin lock entry "python" resolves outside the plugin store.')
  })

  it('resolves the package exports entry for an installed plugin package', async () => {
    const projectRoot = await createTempProject()
    const packageDir = await writeInstalledPackage(projectRoot)

    await expect(resolveInstalledPackageEntry(packageDir)).resolves.toBe('./dist/index.mjs')
    await expect(resolveInstalledPackageRelativeEntry(packageDir)).resolves.toBe('dist/index.mjs')
  })

  it('throws when the installed package has no resolvable root export', async () => {
    const projectRoot = await createTempProject()
    const packageDir = join(projectRoot, '.alint', 'plugins', 'store', 'missing-export', '1.0.0', 'package')
    await mkdir(packageDir, { recursive: true })
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({
      name: 'missing-export',
      type: 'module',
      version: '1.0.0',
    }), 'utf8')

    await expect(resolveInstalledPackageEntry(packageDir))
      .rejects
      .toThrow('Package "missing-export" does not define a resolvable "." export.')
  })
})
