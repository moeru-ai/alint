import type { Readable } from 'node:stream'

import type { RegistryPluginSpecifier } from './spec'
import type {
  DirectoryPluginLockEntry,
  RegistryPluginLockEntry,
  StaticPluginInstallOptions,
  StaticPluginInstallResult,
} from './types'

import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, realpath, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix, relative, resolve, win32 } from 'node:path'
import { Readable as NodeReadable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'

import tar from 'tar-stream'

import { ofetch } from 'ofetch'

import { loadStaticConfig } from '../config/load'
import { getProjectPluginStorePath } from '../paths'
import { isENOENTError, isPathInside } from '../utils/fs'
import { checkIntegrity } from './integrity'
import { createEmptyPluginLockFile, writePluginLockFile } from './lock'
import { registerDirectoryPackage, resolveInstalledPackageRelativeEntry } from './package'
import { getPluginSpecifierKey } from './spec'

const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'

interface InstalledPackage extends Omit<RegistryPluginLockEntry, 'alias' | 'specifier'> {}

interface InstallRegistryPackageOptions {
  cwd: string
  npmRegistry: string
  specifier: RegistryPluginSpecifier
}

interface NpmMetadata {
  versions?: Record<string, {
    dist?: {
      integrity?: string
      tarball?: string
    }
  }>
}

export async function installStaticPlugins(
  options: StaticPluginInstallOptions,
): Promise<StaticPluginInstallResult> {
  const config = await loadStaticConfig(options.cwd, options.configFile)
  const configuredPlugins = config.groups.flatMap(group => group.plugins)
  const npmRegistry = options.registry ?? DEFAULT_REGISTRY
  const lockFile = createEmptyPluginLockFile()
  const registryInstallations = new Map<string, Promise<InstalledPackage>>()
  const directoryRegistrations = new Map<string, Promise<DirectoryPluginLockEntry>>()
  const directoryEntries = new Map<string, DirectoryPluginLockEntry>()

  for (const configuredPlugin of configuredPlugins) {
    const specifier = configuredPlugin.specifier

    if (specifier.type === 'directory') {
      const key = getPluginSpecifierKey(specifier)
      let registration = directoryRegistrations.get(key)

      if (registration === undefined) {
        registration = registerDirectoryPackage(configuredPlugin.alias, specifier)
        directoryRegistrations.set(key, registration)
      }

      const registered = await registration
      const canonical = registered.path
      const existing = directoryEntries.get(canonical)
      const entry = existing ?? registered
      directoryEntries.set(canonical, entry)
      lockFile.plugins[configuredPlugin.alias] = {
        ...entry,
        alias: configuredPlugin.alias,
        path: await toDirectoryLockPath(entry.path, options.cwd),
        specifier: specifier.raw,
      }
      continue
    }

    const key = getPluginSpecifierKey(specifier)
    let packageInstallation = registryInstallations.get(key)

    if (packageInstallation === undefined) {
      packageInstallation = installRegistryPackage({
        cwd: options.cwd,
        npmRegistry,
        specifier,
      })
      registryInstallations.set(key, packageInstallation)
    }

    const installedPackage = await packageInstallation

    lockFile.plugins[configuredPlugin.alias] = {
      alias: configuredPlugin.alias,
      entry: installedPackage.entry,
      integrity: installedPackage.integrity,
      name: installedPackage.name,
      registry: installedPackage.registry,
      specifier: specifier.raw,
      tarball: installedPackage.tarball,
      type: 'registry',
      version: installedPackage.version,
    }
  }

  await writePluginLockFile(options.cwd, lockFile)

  return {
    configuredPluginCount: configuredPlugins.length,
    installedRegistryCount: registryInstallations.size,
    lock: lockFile,
    registeredDirectoryCount: directoryEntries.size,
  }
}

async function extractPackageEntry(
  packageDir: string,
  header: tar.Headers,
  stream: Readable,
): Promise<void> {
  const entryName = header.name

  if (!entryName.startsWith('package/')) {
    stream.resume()
    return
  }

  const relativeEntry = entryName.slice('package/'.length)
  const normalized = posix.normalize(relativeEntry)

  if (relativeEntry === '' || normalized === '.') {
    stream.resume()
    return
  }

  if (
    normalized === '..'
    || normalized.startsWith('../')
    || posix.isAbsolute(normalized)
  ) {
    stream.resume()
    throw new Error(`Plugin tarball entry "${entryName}" escapes the package directory.`)
  }

  const outputPath = resolve(packageDir, normalized)

  if (!isPathInside(outputPath, packageDir)) {
    stream.resume()
    throw new Error(`Plugin tarball entry "${entryName}" escapes the package directory.`)
  }

  if (header.type === 'directory') {
    stream.resume()
    await mkdir(outputPath, { recursive: true })
    return
  }

  if (header.type !== 'file') {
    stream.resume()
    return
  }

  await mkdir(dirname(outputPath), { recursive: true })
  await pipeline(stream, createWriteStream(outputPath))
}

async function extractPackageTarball(tarball: Buffer, packageDir: string): Promise<void> {
  const extract = tar.extract()

  extract.on('entry', (header, stream, next) => {
    void extractPackageEntry(packageDir, header, stream)
      .then(() => next())
      .catch(error => extract.destroy(error))
  })

  await pipeline(
    NodeReadable.from(tarball),
    createGunzip(),
    extract,
  )
}

async function installRegistryPackage(options: InstallRegistryPackageOptions): Promise<InstalledPackage> {
  const { name, segments, version } = options.specifier
  const npmRegistry = options.npmRegistry.endsWith('/') ? options.npmRegistry : `${options.npmRegistry}/`
  const metadataUrl = `${npmRegistry.replace(/\/$/u, '')}/${options.specifier.registryPath}`
  const metadata = await ofetch<NpmMetadata>(metadataUrl)
  const dist = metadata.versions?.[version]?.dist

  if (dist?.tarball === undefined) {
    throw new Error(`Npm metadata for "${name}" does not include a tarball for version ${version}.`)
  }

  if (dist.integrity === undefined || dist.integrity.trim() === '') {
    throw new Error(`Npm metadata for "${name}" does not include integrity for version ${version}.`)
  }

  const storePath = getProjectPluginStorePath(options.cwd)
  const packageDir = join(storePath, ...segments, version, 'package')

  if (!isPathInside(resolve(packageDir), resolve(storePath))) {
    throw new Error(`Static plugin package "${name}" resolves outside the project plugin store.`)
  }

  const packageParentDir = dirname(packageDir)
  const stagingPackageDir = join(packageParentDir, `package-staging-${randomUUID()}`)

  let relativeEntry: string

  try {
    const tarball = Buffer.from(await ofetch<ArrayBuffer, 'arrayBuffer'>(dist.tarball, { responseType: 'arrayBuffer' }))
    checkIntegrity(tarball, dist.integrity, `${name}@${version}`)

    await mkdir(stagingPackageDir, { recursive: true })
    await extractPackageTarball(tarball, stagingPackageDir)
    relativeEntry = await resolveInstalledPackageRelativeEntry(stagingPackageDir)
    await replacePackageDirectory(packageDir, stagingPackageDir)
  }
  catch (error) {
    await rm(stagingPackageDir, { force: true, recursive: true })
    throw error
  }

  return {
    entry: posix.join('.alint/plugins/store', ...segments, version, 'package', relativeEntry.split(/[\\/]/u).join('/')),
    integrity: dist.integrity,
    name,
    registry: npmRegistry,
    tarball: dist.tarball,
    type: 'registry',
    version,
  }
}

async function replacePackageDirectory(packageDir: string, stagingPackageDir: string): Promise<void> {
  const backupPackageDir = join(dirname(packageDir), `package-backup-${randomUUID()}`)
  let hasBackup = false
  let replaced = false

  try {
    await rename(packageDir, backupPackageDir)
    hasBackup = true
  }
  catch (error) {
    if (!isENOENTError(error)) {
      throw error
    }
  }

  try {
    await rename(stagingPackageDir, packageDir)
    replaced = true
  }
  catch (error) {
    if (hasBackup) {
      // Directory replacement cannot be made crash-proof portably; this keeps
      // the previous install when the staging rename fails before replacement.
      await rename(backupPackageDir, packageDir)
      hasBackup = false
    }

    throw error
  }
  finally {
    if (replaced || !hasBackup) {
      await rm(backupPackageDir, { force: true, recursive: true })
    }
  }
}

async function toDirectoryLockPath(directory: string, cwd: string): Promise<string> {
  const relativePath = relative(await realpath(cwd), directory)

  if (isAbsolute(relativePath) || win32.isAbsolute(relativePath)) {
    return directory
  }

  return relativePath === '' ? '.' : relativePath
}
