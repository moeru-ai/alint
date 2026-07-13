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
  const registryInstallations = new Map<string, Promise<InstalledPackageSource>>()
  const directoryRegistrations = new Map<string, Promise<InstalledLocalSource>>()
  const directoryEntries = new Map<string, InstalledLocalSource>()

  for (const configuredPlugin of configuredPlugins) {
    const specifier = configuredPlugin.specifier

    if (specifier.type === 'directory') {
      const key = getPluginSpecifierKey(specifier)
      let registration = directoryRegistrations.get(key)

      if (registration === undefined) {
        registration = installLocalSource({ alias: configuredPlugin.alias, specifier })
        directoryRegistrations.set(key, registration)
      }

      const registered = await registration
      const canonical = registered.path
      const existing = directoryEntries.get(canonical)
      const entry = existing ?? registered
      directoryEntries.set(canonical, entry)
      lockFile.plugins[configuredPlugin.alias] = await createLocalLockEntry(entry, {
        alias: configuredPlugin.alias,
        cwd: options.cwd,
        specifier,
      })
      continue
    }

    const key = getPluginSpecifierKey(specifier)
    let packageInstallation = registryInstallations.get(key)

    if (packageInstallation === undefined) {
      packageInstallation = installPackageSource({
        cwd: options.cwd,
        npmRegistry,
        specifier,
      })
      registryInstallations.set(key, packageInstallation)
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
    installedRegistryCount: registryInstallations.size,
    lock: lockFile,
    registeredDirectoryCount: directoryEntries.size,
  }
}
