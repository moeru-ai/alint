import type { StaticPluginReference } from '../config/static'
import type {
  ParsedPluginLockEntry,
  ParsedPluginLockFile,
  PluginLockFile,
} from './types'

import { readFile } from 'node:fs/promises'

import {
  literal,
  object,
  parse,
  record,
  string,
} from 'valibot'

import { getProjectPluginLockPath } from '../paths'
import { formatPluginSpecifier, parsePluginSpecifier } from './spec'

const PluginLockEntrySchema = object({
  alias: string(),
  entry: string(),
  integrity: string(),
  name: string(),
  registry: string(),
  specifier: string(),
  tarball: string(),
  version: string(),
})

const PluginLockFileSchema = object({
  plugins: record(string(), PluginLockEntrySchema),
  version: literal(1),
})

export function createEmptyPluginLockFile(): PluginLockFile {
  return { plugins: {}, version: 1 }
}

export async function loadPluginLockFile(cwd: string): Promise<PluginLockFile> {
  try {
    return parsePluginLockFileValue(await readFile(getProjectPluginLockPath(cwd), 'utf8'))
  }
  catch (error) {
    if (
      error instanceof Error
      && 'code' in error
      && error.code === 'ENOENT'
    ) {
      return createEmptyPluginLockFile()
    }

    throw error
  }
}

export function parsePluginLockFile(
  value: unknown,
  options: { cwd: string },
): ParsedPluginLockFile {
  const file = parsePluginLockFileValue(value)
  const entries = Object.values(file.plugins).map((entry): ParsedPluginLockEntry => ({
    alias: entry.alias,
    cwd: options.cwd,
    lockEntry: entry,
    specifier: parsePluginSpecifier(entry.specifier),
  }))
  const byAlias = new Map(entries.map(entry => [entry.alias, entry]))

  return {
    cwd: options.cwd,
    entries,
    file,
    find(reference: StaticPluginReference) {
      const entry = byAlias.get(reference.alias)
      return entry?.lockEntry.specifier === formatPluginSpecifier(reference.specifier)
        ? entry
        : undefined
    },
    get(reference: StaticPluginReference) {
      const entry = byAlias.get(reference.alias)
      const expected = formatPluginSpecifier(reference.specifier)

      if (entry === undefined) {
        throw new Error(`Plugin "${reference.alias}" requires ${expected}, but no matching lock entry exists.\nRun: alint plugin install`)
      }

      if (entry.lockEntry.specifier !== expected) {
        throw new Error(`Plugin "${reference.alias}" is locked to ${entry.lockEntry.specifier}, but config requires ${expected}.\nRun: alint plugin install`)
      }

      return entry
    },
  }
}

function parsePluginLockFileValue(value: unknown): PluginLockFile {
  const parsedValue = typeof value === 'string' ? JSON.parse(value) as unknown : value
  const file = parse(PluginLockFileSchema, parsedValue)

  for (const [alias, entry] of Object.entries(file.plugins)) {
    if (entry.alias !== alias) {
      throw new Error(`Plugin lock entry key "${alias}" must match alias "${entry.alias}".`)
    }
  }

  return file
}
