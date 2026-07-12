import type { DirectoryPluginSpecifier } from './spec'
import type { ParsedDirectoryPluginLockEntry, ParsedPluginLockEntry } from './types'

import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

import { join } from 'pathe'
import { afterEach, describe, expect, it } from 'vitest'

import { parsePluginLockFile } from './lock'
import {
  importResolvedPluginPackage,
  registerDirectoryPackage,
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
    const specifier = parsePluginSpecifier('@alint-js/plugin-python@0.3.1')

    if (specifier.type !== 'registry') {
      throw new Error('Expected registry plugin specifier fixture.')
    }

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
        type: 'registry',
        version: '0.3.1',
      },
      specifier,
      type: 'registry',
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

  function createDirectorySpecifier(directory: string, raw = directory): DirectoryPluginSpecifier {
    return { directory, raw, type: 'directory' }
  }

  function createDirectoryLockEntry(
    cwd: string,
    specifier: DirectoryPluginSpecifier,
    path: string,
  ): ParsedDirectoryPluginLockEntry {
    return {
      alias: 'local',
      cwd,
      lockEntry: {
        alias: 'local',
        path,
        specifier: specifier.raw,
        type: 'directory',
      },
      specifier,
      type: 'directory',
    }
  }

  async function writeDirectoryPackage(packageDir: string, entry = './dist/index.mjs'): Promise<void> {
    await mkdir(join(packageDir, 'dist'), { recursive: true })
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({
      exports: { '.': entry },
      name: 'local-plugin',
      type: 'module',
    }), 'utf8')
    await writeFile(join(packageDir, 'dist', 'index.mjs'), 'export default { rules: { local: {} } }\n', 'utf8')
  }

  it('registers, resolves, and imports a directory package', async () => {
    const projectRoot = await createTempProject()
    const packageDir = join(projectRoot, 'plugins', 'local')
    await writeDirectoryPackage(packageDir)
    const specifier = createDirectorySpecifier(packageDir, './plugins/local')

    const lockEntry = await registerDirectoryPackage('local', specifier)
    const resolved = await resolveLockedPluginPackage(createDirectoryLockEntry(projectRoot, specifier, lockEntry.path))
    const plugin = await importResolvedPluginPackage(resolved)
    const physicalPackageDir = await realpath(packageDir)

    expect(lockEntry).toEqual({ alias: 'local', path: physicalPackageDir, specifier: './plugins/local', type: 'directory' })
    expect(resolved.entry).toBe(join(physicalPackageDir, 'dist', 'index.mjs'))
    expect(plugin).toEqual({ rules: { local: {} } })
  })

  it('registers a directory package without importing its root entry', async () => {
    const projectRoot = await createTempProject()
    const packageDir = join(projectRoot, 'plugin')
    const markerPath = join(projectRoot, 'entry-imported')
    await writeDirectoryPackage(packageDir)
    await writeFile(join(packageDir, 'dist', 'index.mjs'), `
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(markerPath)}, '')
throw new Error('entry must not be imported during registration')
`, 'utf8')

    await expect(registerDirectoryPackage('local', createDirectorySpecifier(packageDir)))
      .resolves
      .toMatchObject({ alias: 'local', type: 'directory' })
    await expect(access(markerPath))
      .rejects
      .toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a missing directory package', async () => {
    const projectRoot = await createTempProject()
    const packageDir = join(projectRoot, 'missing')

    await expect(registerDirectoryPackage('local', createDirectorySpecifier(packageDir)))
      .rejects
      .toThrow(`Directory plugin "local" does not exist at "${packageDir}".`)
  })

  it('rejects a directory package path that is a file', async () => {
    const projectRoot = await createTempProject()
    const packagePath = join(projectRoot, 'plugin.mjs')
    await writeFile(packagePath, 'export default {}\n', 'utf8')

    await expect(registerDirectoryPackage('local', createDirectorySpecifier(packagePath)))
      .rejects
      .toThrow(`Directory plugin "local" path "${packagePath}" is not a directory.`)
  })

  it('rejects an invalid directory package manifest', async () => {
    const projectRoot = await createTempProject()
    const packageDir = join(projectRoot, 'plugin')
    await mkdir(packageDir)
    await writeFile(join(packageDir, 'package.json'), '{invalid', 'utf8')

    await expect(registerDirectoryPackage('local', createDirectorySpecifier(packageDir)))
      .rejects
      .toThrow(`Directory plugin "local" has an unreadable or invalid package.json at "${join(await realpath(packageDir), 'package.json')}"`)
  })

  it('rejects a directory package without a root export', async () => {
    const projectRoot = await createTempProject()
    const packageDir = join(projectRoot, 'plugin')
    await mkdir(packageDir)
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: 'local-plugin' }), 'utf8')

    await expect(registerDirectoryPackage('local', createDirectorySpecifier(packageDir)))
      .rejects
      .toThrow('Package "local-plugin" does not define a resolvable "." export.')
  })

  it('rejects a directory package with a missing build entry', async () => {
    const projectRoot = await createTempProject()
    const packageDir = join(projectRoot, 'plugin')
    await mkdir(packageDir)
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({
      exports: { '.': './dist/index.mjs' },
      name: 'local-plugin',
      type: 'module',
    }), 'utf8')

    await expect(registerDirectoryPackage('local', createDirectorySpecifier(packageDir)))
      .rejects
      .toThrow('Directory plugin "local" entry "dist/index.mjs" does not exist. Build the package and try again.')
  })

  it('rejects an existing root entry that is not a regular file', async () => {
    const projectRoot = await createTempProject()
    const packageDir = join(projectRoot, 'plugin')
    await mkdir(join(packageDir, 'dist'), { recursive: true })
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({
      exports: { '.': './dist' },
      name: 'local-plugin',
      type: 'module',
    }), 'utf8')

    await expect(registerDirectoryPackage('local', createDirectorySpecifier(packageDir)))
      .rejects
      .toThrow('Directory plugin "local" entry "dist" is not a regular file.')
  })

  it('rejects a directory package whose export lexically escapes its root', async () => {
    const projectRoot = await createTempProject()
    const packageDir = join(projectRoot, 'plugin')
    await mkdir(packageDir)
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({
      exports: { '.': '../outside.mjs' },
      name: 'local-plugin',
      type: 'module',
    }), 'utf8')

    await expect(registerDirectoryPackage('local', createDirectorySpecifier(packageDir)))
      .rejects
      .toThrow('Directory plugin "local" root export escapes the package directory.')
  })

  it('rejects a directory package whose entry symlink physically escapes its root', async () => {
    const projectRoot = await createTempProject()
    const outsideRoot = await createTempProject()
    const packageDir = join(projectRoot, 'plugin')
    await writeDirectoryPackage(packageDir)
    await writeFile(join(outsideRoot, 'index.mjs'), 'export default {}\n', 'utf8')
    await rm(join(packageDir, 'dist', 'index.mjs'))
    await symlink(join(outsideRoot, 'index.mjs'), join(packageDir, 'dist', 'index.mjs'), 'file')

    await expect(registerDirectoryPackage('local', createDirectorySpecifier(packageDir)))
      .rejects
      .toThrow('Directory plugin "local" entry physically escapes the package directory.')
  })

  it('returns the physical path for an entry symlink contained by the package root', async () => {
    const projectRoot = await createTempProject()
    const packageDir = join(projectRoot, 'plugin')
    await writeDirectoryPackage(packageDir)
    const physicalEntry = join(packageDir, 'dist', 'physical.mjs')
    await writeFile(physicalEntry, 'export default { rules: {} }\n', 'utf8')
    await rm(join(packageDir, 'dist', 'index.mjs'))
    await symlink(physicalEntry, join(packageDir, 'dist', 'index.mjs'), 'file')
    const specifier = createDirectorySpecifier(packageDir)
    const lockEntry = await registerDirectoryPackage('local', specifier)

    const resolved = await resolveLockedPluginPackage(createDirectoryLockEntry(projectRoot, specifier, lockEntry.path))

    expect(resolved.entry).toBe(await realpath(physicalEntry))
  })

  it('accepts a source directory symlink and rejects it after retargeting', async () => {
    const projectRoot = await createTempProject()
    const firstRoot = await createTempProject()
    const secondRoot = await createTempProject()
    const linkPath = join(projectRoot, 'local-plugin')
    await writeDirectoryPackage(firstRoot)
    await writeDirectoryPackage(secondRoot)
    await symlink(firstRoot, linkPath, 'dir')
    const specifier = createDirectorySpecifier(linkPath, './local-plugin')
    const lockEntry = await registerDirectoryPackage('local', specifier)

    await expect(resolveLockedPluginPackage(createDirectoryLockEntry(projectRoot, specifier, lockEntry.path)))
      .resolves
      .toMatchObject({ packageDir: await realpath(firstRoot) })

    await rm(linkPath)
    await symlink(secondRoot, linkPath, 'dir')

    await expect(resolveLockedPluginPackage(createDirectoryLockEntry(projectRoot, specifier, lockEntry.path)))
      .rejects
      .toThrow('Directory plugin "local" has moved or its symlink target changed. Run: alint plugin install')
  })

  it('rejects a retargeted config source through a parsed lock lookup', async () => {
    const projectRoot = await createTempProject()
    const firstRoot = await createTempProject()
    const secondRoot = await createTempProject()
    const linkPath = join(projectRoot, 'local-plugin')
    await writeDirectoryPackage(firstRoot)
    await writeDirectoryPackage(secondRoot)
    await symlink(firstRoot, linkPath, 'dir')
    const specifier = createDirectorySpecifier(linkPath, './local-plugin')
    const lockEntry = await registerDirectoryPackage('local', specifier)
    const lock = parsePluginLockFile({ plugins: { local: lockEntry }, version: 2 }, { cwd: projectRoot })

    await rm(linkPath)
    await symlink(secondRoot, linkPath, 'dir')

    await expect(resolveLockedPluginPackage(lock.get({ alias: 'local', specifier })))
      .rejects
      .toThrow('Directory plugin "local" has moved or its symlink target changed. Run: alint plugin install')
  })

  it('reports a non-missing configured directory realpath failure with its filesystem context', async () => {
    const projectRoot = await createTempProject()
    const packageDir = join(projectRoot, 'plugin')
    const loopPath = join(projectRoot, 'loop')
    await writeDirectoryPackage(packageDir)
    await symlink(loopPath, loopPath, 'dir')
    const originalSpecifier = createDirectorySpecifier(packageDir, './local-plugin')
    const lockEntry = await registerDirectoryPackage('local', originalSpecifier)
    const currentSpecifier = createDirectorySpecifier(loopPath, './local-plugin')
    const lock = parsePluginLockFile({ plugins: { local: lockEntry }, version: 2 }, { cwd: projectRoot })

    await expect(resolveLockedPluginPackage(lock.get({ alias: 'local', specifier: currentSpecifier })))
      .rejects
      .toThrow(/Could not resolve configured directory plugin "local".*ELOOP.*too many symbolic links/iu)
  })

  it('resolves changed source and export content within the locked physical root', async () => {
    const projectRoot = await createTempProject()
    const packageDir = join(projectRoot, 'plugin')
    await writeDirectoryPackage(packageDir)
    const specifier = createDirectorySpecifier(packageDir)
    const lockEntry = await registerDirectoryPackage('local', specifier)
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({
      exports: { '.': './dist/next.mjs' },
      name: 'local-plugin',
      type: 'module',
    }), 'utf8')
    await writeFile(join(packageDir, 'dist', 'next.mjs'), 'export default { rules: { next: {} } }\n', 'utf8')

    const resolved = await resolveLockedPluginPackage(createDirectoryLockEntry(projectRoot, specifier, lockEntry.path))
    const plugin = await importResolvedPluginPackage(resolved)

    expect(resolved.entry).toBe(join(await realpath(packageDir), 'dist', 'next.mjs'))
    expect(plugin).toEqual({ rules: { next: {} } })
  })

  it('constrains the root entry without scanning its normal module imports', async () => {
    const projectRoot = await createTempProject()
    const packageDir = join(projectRoot, 'plugin')
    const siblingModule = join(projectRoot, 'shared.mjs')
    await writeDirectoryPackage(packageDir)
    await writeFile(siblingModule, 'export const sharedRule = {}\n', 'utf8')
    await writeFile(join(packageDir, 'dist', 'index.mjs'), `
import { sharedRule } from ${JSON.stringify(pathToFileURL(siblingModule).href)}
export default { rules: { shared: sharedRule } }
`, 'utf8')
    const specifier = createDirectorySpecifier(packageDir)
    const lockEntry = await registerDirectoryPackage('local', specifier)

    const resolved = await resolveLockedPluginPackage(createDirectoryLockEntry(projectRoot, specifier, lockEntry.path))
    const plugin = await importResolvedPluginPackage(resolved)

    expect(plugin).toEqual({ rules: { shared: {} } })
  })

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
