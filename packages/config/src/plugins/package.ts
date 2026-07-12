import type { PluginDefinition } from '@alint-js/core'
import type { PackageJson } from '@package-json/types'

import type { DirectoryPluginSpecifier } from './spec'
import type {
  DirectoryPluginLockEntry,
  ParsedDirectoryPluginLockEntry,
  ParsedPluginLockEntry,
  ParsedRegistryPluginLockEntry,
  ResolvedPluginPackage,
} from './types'

import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'

import { errorMessageFrom } from '@moeru/std/error'
import { isPlainObject } from 'es-toolkit/compat'
import { exports as resolvePackageExports } from 'resolve.exports'

import { exists, isENOENTError, isPathInside } from '../utils/fs'

export async function importResolvedPluginPackage(resolved: ResolvedPluginPackage): Promise<PluginDefinition> {
  const url = pathToFileURL(resolved.entry)

  if (resolved.live === true) {
    url.searchParams.set('content', createHash('sha256').update(await readFile(resolved.entry)).digest('hex'))
  }

  const importedModule: unknown = await import(url.href)
  return getDefaultExport<PluginDefinition>(importedModule)
}

export async function registerDirectoryPackage(
  alias: string,
  specifier: DirectoryPluginSpecifier,
): Promise<DirectoryPluginLockEntry> {
  const packageDir = await resolveDirectoryRoot(alias, specifier.directory)
  await validatePackageRoot(alias, packageDir)

  return { alias, path: packageDir, specifier: specifier.raw, type: 'directory' }
}

export async function resolveInstalledPackageEntry(packageDir: string): Promise<string> {
  return resolveRootExport(await readPackageJson(packageDir))
}

export async function resolveInstalledPackageRelativeEntry(packageDir: string): Promise<string> {
  return normalizePackageRelativeEntry(await resolveInstalledPackageEntry(packageDir))
}

export async function resolveLockedDirectoryPackage(entry: ParsedDirectoryPluginLockEntry): Promise<ResolvedPluginPackage> {
  const [packageDir, lockedPackageDir] = await Promise.all([
    resolveLockedDirectoryRoot(entry.alias, entry.specifier.directory, 'configured'),
    resolveLockedDirectoryRoot(entry.alias, resolveDirectoryLockPath(entry), 'locked'),
  ])

  if (packageDir !== lockedPackageDir) {
    throw directoryChangedError(entry.alias)
  }

  return { ...await validatePackageRoot(entry.alias, packageDir), live: true }
}

export async function resolveLockedPluginPackage(entry: ParsedPluginLockEntry): Promise<ResolvedPluginPackage> {
  return entry.type === 'directory'
    ? resolveLockedDirectoryPackage(entry)
    : resolveLockedRegistryPackage(entry)
}

function directoryChangedError(alias: string): Error {
  return new Error(`Directory plugin "${alias}" has moved or its symlink target changed. Run: alint plugin install`)
}

function getDefaultExport<T = unknown>(value: unknown): T {
  if (!isPlainObject(value)) {
    return value as T
  }

  const objectValue = value as object
  return Object.hasOwn(objectValue, 'default') ? Reflect.get(objectValue, 'default') as T : value as T
}

function getLockedPackageDir(projectRoot: string, pluginRoot: string, entry: ParsedRegistryPluginLockEntry): string {
  const name = entry.lockEntry.name
  const version = entry.lockEntry.version

  if (entry.specifier.name !== name) {
    throw new Error(`Plugin lock entry "${entry.alias}" package name does not match its specifier.`)
  }

  if (entry.specifier.version !== version) {
    throw new Error(`Plugin lock entry "${entry.alias}" package version does not match its specifier.`)
  }

  const packageDir = join(pluginRoot, ...getPackagePathSegments(name), version, 'package')

  if (!isPathInside(packageDir, projectRoot) || !isPathInside(packageDir, pluginRoot)) {
    throw new Error(`Plugin lock entry "${entry.alias}" package metadata resolves outside the plugin store.`)
  }

  return packageDir
}

function getPackageName(packageJson: PackageJson): string {
  return typeof packageJson.name === 'string' ? packageJson.name : '<unknown>'
}

function getPackagePathSegments(name: string): string[] {
  const segments = name.split('/')
  const segmentPattern = /^[\w.-]+$/u

  if (segments.length === 2) {
    const [scope, packageName] = segments

    if (scope === undefined || packageName === undefined || !scope.startsWith('@') || !segmentPattern.test(scope.slice(1)) || !segmentPattern.test(packageName)) {
      throw new Error(`Invalid static plugin package name "${name}".`)
    }

    return segments
  }

  if (segments.length !== 1 || !segmentPattern.test(segments[0]!)) {
    throw new Error(`Invalid static plugin package name "${name}".`)
  }

  return segments
}

async function nearestExistingParent(path: string): Promise<string> {
  let current = path

  while (current !== dirname(current)) {
    if (await exists(current)) {
      return current
    }

    current = dirname(current)
  }

  return current
}

function normalizePackageRelativeEntry(entry: string): string {
  return entry.startsWith('./') ? entry.slice(2) : entry
}

async function readDirectoryPackageJson(alias: string, packageDir: string): Promise<PackageJson> {
  const manifestPath = join(packageDir, 'package.json')

  try {
    const value: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))

    if (!isPlainObject(value)) {
      throw new Error('package manifest must be an object')
    }

    return value as PackageJson
  }
  catch (error) {
    throw new Error(`Directory plugin "${alias}" has an unreadable or invalid package.json at "${manifestPath}": ${errorMessageFrom(error) ?? 'unknown error'}`)
  }
}

async function readPackageJson(packageDir: string): Promise<PackageJson> {
  return JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')) as PackageJson
}

function resolveDirectoryLockPath(entry: ParsedDirectoryPluginLockEntry): string {
  return isAbsolute(entry.lockEntry.path) || win32.isAbsolute(entry.lockEntry.path)
    ? entry.lockEntry.path
    : resolve(entry.cwd, entry.lockEntry.path)
}

async function resolveDirectoryRoot(alias: string, directory: string): Promise<string> {
  let directoryStat

  try {
    directoryStat = await stat(directory)
  }
  catch (error) {
    if (isENOENTError(error)) {
      throw new Error(`Directory plugin "${alias}" does not exist at "${directory}".`)
    }

    throw new Error(`Could not inspect directory plugin "${alias}" at "${directory}": ${errorMessageFrom(error) ?? 'unknown error'}`)
  }

  if (!directoryStat.isDirectory()) {
    throw new Error(`Directory plugin "${alias}" path "${directory}" is not a directory.`)
  }

  return realpath(directory)
}

async function resolveLockedDirectoryRoot(
  alias: string,
  directory: string,
  source: 'configured' | 'locked',
): Promise<string> {
  try {
    return await realpath(directory)
  }
  catch (error) {
    if (isENOENTError(error)) {
      throw directoryChangedError(alias)
    }

    throw new Error(`Could not resolve ${source} directory plugin "${alias}" at "${directory}": ${errorMessageFrom(error) ?? 'unknown error'}`)
  }
}

async function resolveLockedRegistryPackage(entry: ParsedRegistryPluginLockEntry): Promise<ResolvedPluginPackage> {
  const projectRoot = resolve(entry.cwd)
  const pluginRoot = join(projectRoot, '.alint', 'plugins', 'store')
  const rawEntryPath = entry.lockEntry.entry
  const resolvedEntry = isAbsolute(rawEntryPath) ? resolve(rawEntryPath) : resolve(projectRoot, rawEntryPath)

  if (!isPathInside(resolvedEntry, projectRoot)) {
    throw new Error(`Plugin lock entry "${entry.alias}" resolves outside the project root.`)
  }

  const [physicalEntry, physicalPluginRoot] = await Promise.all([
    resolvePhysicalPath(resolvedEntry),
    realpath(pluginRoot),
  ])

  if (!isPathInside(physicalEntry, physicalPluginRoot)) {
    throw new Error(`Plugin lock entry "${entry.alias}" resolves outside the plugin store.`)
  }

  const packageDir = getLockedPackageDir(projectRoot, pluginRoot, entry)
  const physicalPackageDir = await realpath(packageDir)
  const expectedPhysicalPackageDir = join(physicalPluginRoot, ...getPackagePathSegments(entry.lockEntry.name), entry.lockEntry.version, 'package')

  if (physicalPackageDir !== expectedPhysicalPackageDir) {
    throw new Error(`Plugin lock entry "${entry.alias}" resolves outside the locked package directory.`)
  }

  if (!isPathInside(resolvedEntry, packageDir)) {
    throw new Error(`Plugin lock entry "${entry.alias}" resolves outside the locked package directory.`)
  }

  return { entry: resolvedEntry, packageDir, packageJson: await readPackageJson(packageDir) }
}

async function resolvePhysicalPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  }
  catch (error) {
    if (!isENOENTError(error)) {
      throw error
    }
  }

  const parent = await nearestExistingParent(dirname(path))
  return join(await realpath(parent), relative(parent, path))
}

function resolveRootExport(packageJson: PackageJson): string {
  const [entry] = resolvePackageExports(packageJson, '.', { browser: false, require: false }) ?? []

  if (entry === undefined) {
    throw new Error(`Package "${getPackageName(packageJson)}" does not define a resolvable "." export.`)
  }

  return entry
}

async function validatePackageRoot(alias: string, packageDir: string): Promise<ResolvedPluginPackage> {
  const packageJson = await readDirectoryPackageJson(alias, packageDir)
  const relativeEntry = normalizePackageRelativeEntry(resolveRootExport(packageJson))
  const entry = resolve(packageDir, relativeEntry)

  if (!isPathInside(entry, packageDir)) {
    throw new Error(`Directory plugin "${alias}" root export escapes the package directory.`)
  }

  let entryStat

  try {
    entryStat = await stat(entry)
  }
  catch (error) {
    if (isENOENTError(error)) {
      throw new Error(`Directory plugin "${alias}" entry "${relativeEntry}" does not exist. Build the package and try again.`)
    }

    throw new Error(`Could not inspect directory plugin "${alias}" entry "${relativeEntry}": ${errorMessageFrom(error) ?? 'unknown error'}`)
  }

  if (!entryStat.isFile()) {
    throw new Error(`Directory plugin "${alias}" entry "${relativeEntry}" is not a regular file.`)
  }

  const physicalEntry = await realpath(entry)

  if (!isPathInside(physicalEntry, packageDir)) {
    throw new Error(`Directory plugin "${alias}" entry physically escapes the package directory.`)
  }

  return { entry: physicalEntry, packageDir, packageJson }
}
