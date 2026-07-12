import type { PluginDefinition } from '@alint-js/core'

import type { StaticPluginReference, StaticPluginResolver } from './types'

import { lstat, realpath, stat } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

import { isPlainObject } from 'es-toolkit/compat'
import { dirname, isAbsolute, relative, resolve } from 'pathe'
import { custom, object, optional, safeParse } from 'valibot'

import { isNodeError } from '../nodeError'
import { loadPluginLockFile } from './lock'
import { getProjectPluginStoreDir } from './paths'
import { formatPluginSpecifier } from './spec'

const PluginDefinitionSchema = object({
  configs: optional(custom<Record<string, unknown>>(isPlainObject)),
  languages: optional(custom<Record<string, unknown>>(isPlainObject)),
  processors: optional(custom<Record<string, unknown>>(isPlainObject)),
  rules: optional(custom<Record<string, unknown>>(isPlainObject)),
})

export async function createLockedPluginResolver(cwd: string): Promise<StaticPluginResolver> {
  let lockPromise: ReturnType<typeof loadPluginLockFile> | undefined

  return async (reference: StaticPluginReference): Promise<PluginDefinition> => {
    lockPromise ??= loadPluginLockFile(cwd)
    const lock = await lockPromise
    const expected = formatPluginSpecifier(reference.specifier)
    const entry = lock.plugins[reference.alias]

    if (!entry) {
      throw new Error(`Plugin "${reference.alias}" requires ${expected}, but no matching lock entry exists.\nRun: alint plugin install`)
    }

    if (entry.specifier !== expected) {
      throw new Error(`Plugin "${reference.alias}" is locked to ${entry.specifier}, but config requires ${expected}.\nRun: alint plugin install`)
    }

    const entryPath = await resolveLockedEntryPath(cwd, reference.alias, entry.entry)
    await stat(entryPath)
    const module = await import(pathToFileURL(entryPath).href)

    if (!isPluginDefinition(module.default)) {
      throw new Error(`Plugin "${reference.alias}" default export must be an alint plugin object.`)
    }

    return module.default
  }
}

async function assertStoreBoundaryIsNotSymlink(cwd: string, alias: string): Promise<void> {
  try {
    for (const path of [
      dirname(dirname(getProjectPluginStoreDir(cwd))),
      dirname(getProjectPluginStoreDir(cwd)),
      getProjectPluginStoreDir(cwd),
    ]) {
      const stats = await lstat(path)

      if (stats.isSymbolicLink()) {
        throw new Error(`Plugin "${alias}" lock entry must point inside .alint/plugins/store.`)
      }
    }
  }
  catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new Error(`Plugin "${alias}" lock entry is missing from .alint/plugins/store.\nRun: alint plugin install`, {
        cause: error,
      })
    }

    throw error
  }
}

function isInsideDirectory(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path !== '' && !path.startsWith('..') && !isAbsolute(path)
}

function isPluginDefinition(value: unknown): value is PluginDefinition {
  if (!isPlainObject(value)) {
    return false
  }

  return safeParse(PluginDefinitionSchema, value).success
}

async function resolveLockedEntryPath(cwd: string, alias: string, entry: string): Promise<string> {
  const storeDir = resolve(getProjectPluginStoreDir(cwd))
  const entryPath = resolve(cwd, entry)

  if (isAbsolute(entry) || !isInsideDirectory(storeDir, entryPath)) {
    throw new Error(`Plugin "${alias}" lock entry must point inside .alint/plugins/store.`)
  }

  await assertStoreBoundaryIsNotSymlink(cwd, alias)

  let canonicalEntryPath: string
  let canonicalStoreDir: string

  try {
    canonicalEntryPath = await realpath(entryPath)
    canonicalStoreDir = await realpath(storeDir)
  }
  catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new Error(`Plugin "${alias}" lock entry is missing from .alint/plugins/store.\nRun: alint plugin install`, {
        cause: error,
      })
    }

    throw error
  }

  if (!isInsideDirectory(canonicalStoreDir, canonicalEntryPath)) {
    throw new Error(`Plugin "${alias}" lock entry must point inside .alint/plugins/store.`)
  }

  return canonicalEntryPath
}
