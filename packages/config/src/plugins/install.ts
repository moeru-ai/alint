import type { Readable } from 'node:stream'

import type { ParsedPluginSpecifier } from './spec'
import type {
  PluginLockEntry,
  StaticPluginInstallOptions,
  StaticPluginInstallResult,
} from './types'

import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path'
import { Readable as NodeReadable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'

import tar from 'tar-stream'

import { isPlainObject } from 'es-toolkit/compat'
import { ofetch } from 'ofetch'

import { loadStaticConfig } from '../config/load'
import { getProjectPluginStorePath } from '../paths'
import { isENOENTError } from '../utils/fs'
import { checkIntegrity } from './integrity'
import { createEmptyPluginLockFile, writePluginLockFile } from './lock'
import { resolveInstalledPackageRelativeEntry } from './package'
import { formatPluginSpecifier } from './spec'

const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'

interface InstalledPackage extends Omit<PluginLockEntry, 'alias' | 'specifier'> {}

interface InstallPackageOptions {
  cwd: string
  installedSpecifiers: Map<string, Promise<InstalledPackage>>
  registry: string
  specifier: ParsedPluginSpecifier
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
  const references = config.groups.flatMap(group => group.plugins)
  const rawRegistry = options.registry ?? DEFAULT_REGISTRY
  const registry = rawRegistry.endsWith('/') ? rawRegistry : `${rawRegistry}/`
  const lock = createEmptyPluginLockFile()
  const installedSpecifiers = new Map<string, Promise<InstalledPackage>>()

  for (const reference of references) {
    const specifier = formatPluginSpecifier(reference.specifier)
    const installed = await getOrInstallPackage({
      cwd: options.cwd,
      installedSpecifiers,
      registry,
      specifier: reference.specifier,
    })

    lock.plugins[reference.alias] = {
      alias: reference.alias,
      entry: installed.entry,
      integrity: installed.integrity,
      name: installed.name,
      registry,
      specifier,
      tarball: installed.tarball,
      version: installed.version,
    }
  }

  await writePluginLockFile(options.cwd, lock)

  return {
    installedCount: installedSpecifiers.size,
    lock,
    referenceCount: references.length,
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

async function fetchPackageMetadata(registry: string, specifier: ParsedPluginSpecifier): Promise<NpmMetadata> {
  const url = `${registry.replace(/\/$/u, '')}/${specifier.registryPath}`
  const value = await ofetch<unknown>(url)
  if (!isPlainObject(value)) {
    throw new Error(`Npm metadata for "${specifier.name}" must be an object.`)
  }

  return value as NpmMetadata
}

async function getOrInstallPackage(options: InstallPackageOptions): Promise<InstalledPackage> {
  const specifier = formatPluginSpecifier(options.specifier)
  const existing = options.installedSpecifiers.get(specifier)

  if (existing !== undefined) {
    return existing
  }

  const installed = installPackage(options)
  options.installedSpecifiers.set(specifier, installed)
  return installed
}

async function installPackage(options: Omit<InstallPackageOptions, 'installedSpecifiers'>): Promise<InstalledPackage> {
  const { name, segments, version } = options.specifier
  const metadata = await fetchPackageMetadata(options.registry, options.specifier)
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
    registry: options.registry,
    tarball: dist.tarball,
    version,
  }
}

function isPathInside(path: string, parent: string): boolean {
  const childRelativePath = relative(parent, path)
  return childRelativePath === ''
    || (!childRelativePath.startsWith('..') && !isAbsolute(childRelativePath))
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
