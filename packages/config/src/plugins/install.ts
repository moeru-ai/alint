import type { InstalledLocalSource } from './sources/local'
import type { InstalledPackageSource } from './sources/package'
import type {
  StaticPluginInstallOptions,
  StaticPluginInstallResult,
} from './types'

import { loadStaticConfig } from '../config/load'
import { createEmptyPluginLockFile, writePluginLockFile } from './lock'
import {
  createLockEntry as createLocalLockEntry,
  install as installLocalSource,
} from './sources/local'
import {
  createLockEntry as createPackageLockEntry,
  install as installPackageSource,
} from './sources/package'
import { getPluginSpecifierKey } from './spec'

const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'

export async function installStaticPlugins(
  options: StaticPluginInstallOptions,
): Promise<StaticPluginInstallResult> {
  const config = await loadStaticConfig(options.cwd, options.configFile)
  const configuredPlugins = config.groups.flatMap(group => group.plugins)
  const npmRegistry = options.registry ?? DEFAULT_REGISTRY
  const lockFile = createEmptyPluginLockFile()
  const packageInstallations = new Map<string, Promise<InstalledPackageSource>>()
  const localDirectoryInstallations = new Map<string, Promise<InstalledLocalSource>>()
  const installedLocalDirectories = new Map<string, InstalledLocalSource>()

  for (const configuredPlugin of configuredPlugins) {
    const specifier = configuredPlugin.specifier

    if (specifier.type === 'directory') {
      const key = getPluginSpecifierKey(specifier)
      let installation = localDirectoryInstallations.get(key)

      if (installation === undefined) {
        installation = installLocalSource({ alias: configuredPlugin.alias, specifier })
        localDirectoryInstallations.set(key, installation)
      }

      const installed = await installation
      const canonical = installed.path
      const existing = installedLocalDirectories.get(canonical)
      const entry = existing ?? installed
      installedLocalDirectories.set(canonical, entry)
      lockFile.plugins[configuredPlugin.alias] = await createLocalLockEntry(entry, {
        alias: configuredPlugin.alias,
        cwd: options.cwd,
        specifier,
      })
      continue
    }

    const key = getPluginSpecifierKey(specifier)
    let packageInstallation = packageInstallations.get(key)

    if (packageInstallation === undefined) {
      packageInstallation = installPackageSource({
        cwd: options.cwd,
        npmRegistry,
        specifier,
      })
      packageInstallations.set(key, packageInstallation)
    }

    const installedPackage = await packageInstallation

    lockFile.plugins[configuredPlugin.alias] = createPackageLockEntry(installedPackage, {
      alias: configuredPlugin.alias,
      specifier,
    })
  }

  await writePluginLockFile(options.cwd, lockFile)

  return {
    configuredPluginCount: configuredPlugins.length,
    installedLocalDirectoryCount: installedLocalDirectories.size,
    installedPackageCount: packageInstallations.size,
    lock: lockFile,
  }
}
