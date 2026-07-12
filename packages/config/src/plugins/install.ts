import type { Readable } from 'node:stream'

import type {
  PluginLockEntry,
  StaticPluginInstallOptions,
  StaticPluginInstallResult,
} from './types'

import { Buffer } from 'node:buffer'
import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path'
import { Readable as NodeReadable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'

import tar from 'tar-stream'

import { loadStaticConfig } from '../config/load'
import { listStaticPluginReferences } from '../config/static'
import { getProjectPluginStorePath } from '../paths'
import { createEmptyPluginLockFile, writePluginLockFile } from './lock'
import { resolveInstalledPackageRelativeEntry } from './package'
import { formatPluginSpecifier } from './spec'

const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'

interface InstalledPackage extends Omit<PluginLockEntry, 'alias' | 'specifier'> {}

interface InstallPackageOptions {
  cwd: string
  installedSpecifiers: Map<string, Promise<InstalledPackage>>
  registry: string
  specifier: string
}

interface NpmMetadata {
  versions?: Record<string, {
    dist?: {
      integrity?: string
      tarball?: string
    }
  }>
}

interface PackageIdentity {
  name: string
  registryPath: string
  segments: string[]
}

export async function installStaticPlugins(
  options: StaticPluginInstallOptions,
): Promise<StaticPluginInstallResult> {
  const config = await loadStaticConfig(options.cwd, options.configFile)
  const references = listStaticPluginReferences(config)
  const registry = normalizeRegistry(options.registry ?? DEFAULT_REGISTRY)
  const lock = createEmptyPluginLockFile()
  const installedSpecifiers = new Map<string, Promise<InstalledPackage>>()

  for (const reference of references) {
    const specifier = formatPluginSpecifier(reference.specifier)
    const installed = await getOrInstallPackage({
      cwd: options.cwd,
      installedSpecifiers,
      registry,
      specifier,
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

async function downloadBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(`Failed to download "${url}": ${response.status} ${response.statusText}`)
  }

  return Buffer.from(await response.arrayBuffer())
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

async function fetchPackageMetadata(registry: string, identity: PackageIdentity): Promise<NpmMetadata> {
  const url = `${registry.replace(/\/$/u, '')}/${identity.registryPath}`
  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(`Failed to fetch npm metadata for "${identity.name}": ${response.status} ${response.statusText}`)
  }

  const value: unknown = await response.json()

  if (!isPlainObject(value)) {
    throw new Error(`Npm metadata for "${identity.name}" must be an object.`)
  }

  return value as NpmMetadata
}

async function getOrInstallPackage(options: InstallPackageOptions): Promise<InstalledPackage> {
  const existing = options.installedSpecifiers.get(options.specifier)

  if (existing !== undefined) {
    return existing
  }

  const installed = installPackage(options)
  options.installedSpecifiers.set(options.specifier, installed)
  return installed
}

async function installPackage(options: Omit<InstallPackageOptions, 'installedSpecifiers'>): Promise<InstalledPackage> {
  const { name, registryPath, segments, version } = parseVersionedPackageSpecifier(options.specifier)
  const identity = { name, registryPath, segments }
  const metadata = await fetchPackageMetadata(options.registry, identity)
  const dist = metadata.versions?.[version]?.dist

  if (dist?.tarball === undefined) {
    throw new Error(`Npm metadata for "${name}" does not include a tarball for version ${version}.`)
  }

  const packageDir = join(getProjectPluginStorePath(options.cwd), ...segments, version, 'package')
  await rm(packageDir, { force: true, recursive: true })
  await mkdir(packageDir, { recursive: true })
  await extractPackageTarball(await downloadBuffer(dist.tarball), packageDir)

  const relativeEntry = await resolveInstalledPackageRelativeEntry(packageDir)

  return {
    entry: posix.join('.alint/plugins/store', ...segments, version, 'package', relativeEntry.split(/[\\/]/u).join('/')),
    integrity: dist.integrity ?? '',
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeRegistry(registry: string): string {
  return registry.endsWith('/') ? registry : `${registry}/`
}

function parseVersionedPackageSpecifier(specifier: string): PackageIdentity & { version: string } {
  const versionSeparator = specifier.lastIndexOf('@')

  if (versionSeparator <= 0 || versionSeparator === specifier.length - 1) {
    throw new Error(`Static plugin specifier "${specifier}" must include an exact package version.`)
  }

  const name = specifier.slice(0, versionSeparator)
  const version = specifier.slice(versionSeparator + 1)

  return {
    name,
    registryPath: name.startsWith('@')
      ? name.replace('/', '%2f')
      : encodeURIComponent(name),
    segments: name.split('/'),
    version,
  }
}
