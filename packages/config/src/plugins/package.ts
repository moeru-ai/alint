import type { PluginDefinition } from '@alint-js/core'

import type { ParsedPluginLockEntry, ResolvedPluginPackage } from './types'

import { constants } from 'node:fs'
import { access, readFile, realpath } from 'node:fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path'
import { pathToFileURL } from 'node:url'

import { exports as resolvePackageExports } from 'resolve.exports'

export async function importResolvedPluginPackage(resolved: ResolvedPluginPackage): Promise<PluginDefinition> {
  const importedModule: unknown = await import(pathToFileURL(resolved.entry).href)
  const plugin = getDefaultExport(importedModule)

  if (!isPlainObject(plugin)) {
    throw new Error(`Plugin package "${getPackageName(resolved.packageJson)}" must export a plugin object.`)
  }

  for (const property of ['configs', 'languages', 'processors', 'rules'] as const) {
    if (plugin[property] !== undefined && !isPlainObject(plugin[property])) {
      throw new Error(`Plugin package "${getPackageName(resolved.packageJson)}" must export "${property}" as an object when provided.`)
    }
  }

  return plugin as PluginDefinition
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

  const packageDir = findPackageRoot(resolvedEntry)
  const packageJson = await readPackageJson(packageDir)

  return {
    entry: resolvedEntry,
    packageDir,
    packageJson,
  }
}

function findPackageRoot(entry: string): string {
  let current = dirname(entry)

  while (current !== dirname(current)) {
    if (basename(current) === 'package') {
      return current
    }

    current = dirname(current)
  }

  throw new Error(`Plugin entry "${entry}" is not inside an installed package directory.`)
}

function getDefaultExport(value: unknown): unknown {
  if (!isPlainObject(value)) {
    return value
  }

  return Object.hasOwn(value, 'default') ? value.default : value
}

function getPackageName(packageJson: Record<string, unknown>): string {
  return typeof packageJson.name === 'string' ? packageJson.name : '<unknown>'
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
  if (value === null || typeof value !== 'object') {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

async function nearestExistingParent(path: string): Promise<string> {
  let current = path

  while (current !== dirname(current)) {
    try {
      await access(current, constants.F_OK)
      return current
    }
    catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        throw error
      }
    }

    current = dirname(current)
  }

  return current
}

function normalizePackageRelativeEntry(entry: string): string {
  return entry.startsWith('./') ? entry.slice(2) : entry
}

async function readPackageJson(packageDir: string): Promise<Record<string, unknown>> {
  const packageJson = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')) as unknown

  if (!isPlainObject(packageJson)) {
    throw new Error(`Package at "${packageDir}" must have an object package.json.`)
  }

  return packageJson
}

async function resolvePhysicalPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  }
  catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      throw error
    }
  }

  const parent = await nearestExistingParent(dirname(path))
  return join(await realpath(parent), relative(parent, path))
}
