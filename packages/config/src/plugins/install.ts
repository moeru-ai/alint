import type {
  StaticPluginInstallOptions,
  StaticPluginInstallResult,
} from './types'

import { loadStaticConfig } from '../config/load'
import { createEmptyPluginLockFile, writePluginLockFile } from './lock'
import { getPluginSpecifierKey } from './spec'

import * as localSource from './sources/local'
import * as packageSource from './sources/package'

const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'

export async function installStaticPlugins(
  options: StaticPluginInstallOptions,
): Promise<StaticPluginInstallResult> {
  const config = await loadStaticConfig(options.cwd, options.configFile)
  const configuredPlugins = config.groups.flatMap(group => group.plugins)
  const npmRegistry = options.registry ?? DEFAULT_REGISTRY
  const lockFile = createEmptyPluginLockFile()
  const registryInstallations = new Map<string, Promise<packageSource.InstalledPackageSource>>()
  const directoryRegistrations = new Map<string, Promise<localSource.InstalledLocalSource>>()
  const directoryEntries = new Map<string, localSource.InstalledLocalSource>()

  for (const configuredPlugin of configuredPlugins) {
    const specifier = configuredPlugin.specifier

    if (specifier.type === 'directory') {
      const key = getPluginSpecifierKey(specifier)
      let registration = directoryRegistrations.get(key)

      if (registration === undefined) {
        registration = localSource.install({ alias: configuredPlugin.alias, specifier })
        directoryRegistrations.set(key, registration)
      }

      const registered = await registration
      const canonical = registered.path
      const existing = directoryEntries.get(canonical)
      const entry = existing ?? registered
      directoryEntries.set(canonical, entry)
      lockFile.plugins[configuredPlugin.alias] = await localSource.createLockEntry(entry, {
        alias: configuredPlugin.alias,
        cwd: options.cwd,
        specifier,
      })
      continue
    }

    const key = getPluginSpecifierKey(specifier)
    let packageInstallation = registryInstallations.get(key)

    if (packageInstallation === undefined) {
      packageInstallation = packageSource.install({
        cwd: options.cwd,
        npmRegistry,
        specifier,
      })
      registryInstallations.set(key, packageInstallation)
    }

    const installedPackage = await packageInstallation

    lockFile.plugins[configuredPlugin.alias] = packageSource.createLockEntry(installedPackage, {
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
