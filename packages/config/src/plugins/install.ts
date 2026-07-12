import type { Readable } from 'node:stream'

import type { ParsedPluginSpecifier } from '../config/static'
import type {
  PluginLockEntry,
  StaticPluginInstallOptions,
  StaticPluginInstallResult,
} from './types'

import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
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
const SUPPORTED_INTEGRITY_TOKEN_PATTERN = /^(sha512|sha256)-([A-Za-z0-9+/]+={0,2})$/u

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

interface PackageIdentity {
  name: string
  registryPath: string
  segments: string[]
}

interface PackageInstallIdentity extends PackageIdentity {
  version: string
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
  const specifier = formatPluginSpecifier(options.specifier)
  const existing = options.installedSpecifiers.get(specifier)

  if (existing !== undefined) {
    return existing
  }

  const installed = installPackage(options)
  options.installedSpecifiers.set(specifier, installed)
  return installed
}

function getPackageInstallIdentity(specifier: ParsedPluginSpecifier): PackageInstallIdentity {
  if (specifier.version === undefined || specifier.version === '') {
    throw new Error(`Static plugin specifier "${specifier.raw}" must include an exact package version.`)
  }

  const segments = getSafePackageNameSegments(specifier.name)

  return {
    name: specifier.name,
    registryPath: specifier.name.startsWith('@')
      ? specifier.name.replace('/', '%2f')
      : encodeURIComponent(specifier.name),
    segments,
    version: specifier.version,
  }
}

function getSafePackageNameSegments(name: string): string[] {
  if (
    name === ''
    || name.includes('\\')
    || isAbsolute(name)
    || posix.isAbsolute(name)
  ) {
    throw new Error(`Invalid static plugin package name "${name}".`)
  }

  const segments = name.split('/')

  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`Invalid static plugin package name "${name}".`)
  }

  const segmentPattern = /^[a-z0-9][a-z0-9._~-]*$/u

  if (name.startsWith('@')) {
    const [scope, packageName, extraSegment] = segments

    if (
      segments.length !== 2
      || scope === undefined
      || packageName === undefined
      || extraSegment !== undefined
      || !scope.startsWith('@')
      || !segmentPattern.test(scope.slice(1))
      || !segmentPattern.test(packageName)
    ) {
      throw new Error(`Invalid static plugin package name "${name}".`)
    }

    return segments
  }

  if (segments.length !== 1 || !segmentPattern.test(segments[0]!)) {
    throw new Error(`Invalid static plugin package name "${name}".`)
  }

  return segments
}

async function installPackage(options: Omit<InstallPackageOptions, 'installedSpecifiers'>): Promise<InstalledPackage> {
  const { name, registryPath, segments, version } = getPackageInstallIdentity(options.specifier)
  const identity = { name, registryPath, segments }
  const metadata = await fetchPackageMetadata(options.registry, identity)
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
    const tarball = await downloadBuffer(dist.tarball)
    verifyTarballIntegrity(tarball, dist.integrity, `${name}@${version}`)

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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
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

async function replacePackageDirectory(packageDir: string, stagingPackageDir: string): Promise<void> {
  const backupPackageDir = join(dirname(packageDir), `package-backup-${randomUUID()}`)
  let hasBackup = false
  let replaced = false

  try {
    await rename(packageDir, backupPackageDir)
    hasBackup = true
  }
  catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') {
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

function verifyTarballIntegrity(tarball: Buffer, integrity: string, specifier: string): void {
  const supportedTokens = integrity
    .trim()
    .split(/\s+/u)
    .map(token => SUPPORTED_INTEGRITY_TOKEN_PATTERN.exec(token))
    .filter(match => match !== null)

  if (supportedTokens.length === 0) {
    throw new Error(`Unsupported npm integrity format for "${specifier}": "${integrity}".`)
  }

  const matches = supportedTokens.some(([, algorithm, expected]) => {
    const actual = createHash(algorithm).update(tarball).digest('base64')
    return actual === expected
  })

  if (!matches) {
    throw new Error(`Integrity mismatch for "${specifier}".`)
  }
}
