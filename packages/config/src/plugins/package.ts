import type { PluginDefinition } from '@alint-js/core'
import type { PackageJson } from '@package-json/types'

import type { ParsedPluginLockEntry, ResolvedPluginPackage } from './types'

import { readFile, realpath } from 'node:fs/promises'
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path'
import { pathToFileURL } from 'node:url'

import { isPlainObject } from 'es-toolkit/compat'
import { exports as resolvePackageExports } from 'resolve.exports'

import { exists, isENOENTError, isPathInside } from '../utils/fs'

export async function importResolvedPluginPackage(resolved: ResolvedPluginPackage): Promise<PluginDefinition> {
  const importedModule: unknown = await import(pathToFileURL(resolved.entry).href)
  return getDefaultExport<PluginDefinition>(importedModule)
}

export async function resolveInstalledPackageEntry(packageDir: string): Promise<string> {
  const packageJson = await readPackageJson(packageDir)
  const [entry] = resolvePackageExports(packageJson, '.', {
    browser: false,
    require: false,
  }) ?? []

  if (entry === undefined) {
    throw new Error(`Package "${getPackageName(packageJson)}" does not define a resolvable "." export.`)
  }

  return entry
}

export async function resolveInstalledPackageRelativeEntry(packageDir: string): Promise<string> {
  return normalizePackageRelativeEntry(await resolveInstalledPackageEntry(packageDir))
}

export async function resolveLockedPluginPackage(entry: ParsedPluginLockEntry): Promise<ResolvedPluginPackage> {
  const projectRoot = resolve(entry.cwd)
  const pluginRoot = join(projectRoot, '.alint', 'plugins', 'store')
  const rawEntryPath = entry.lockEntry.entry
  const resolvedEntry = isAbsolute(rawEntryPath)
    ? resolve(rawEntryPath)
    : resolve(projectRoot, rawEntryPath)

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

  const packageJson = await readPackageJson(packageDir)

  return {
    entry: resolvedEntry,
    packageDir,
    packageJson,
  }
}

function getDefaultExport<T = unknown>(value: unknown): T {
  if (!isPlainObject(value)) {
    return value as T
  }

  const objectValue = value as object
  return Object.hasOwn(objectValue, 'default') ? Reflect.get(objectValue, 'default') as T : value as T
}

function getLockedPackageDir(projectRoot: string, pluginRoot: string, entry: ParsedPluginLockEntry): string {
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

    if (
      scope === undefined
      || packageName === undefined
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

async function readPackageJson(packageDir: string): Promise<PackageJson> {
  return JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')) as PackageJson
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
