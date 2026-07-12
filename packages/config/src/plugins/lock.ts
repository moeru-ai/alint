import type { ParsedStaticConfig, StaticPluginReference } from '../config/static'
import type {
  ParsedPluginLockEntry,
  ParsedPluginLockFile,
  PluginLockFile,
} from './types'

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  literal,
  object,
  parse,
  record,
  string,
} from 'valibot'

import { getProjectPluginLockPath } from '../paths'
import { isENOENTError } from '../utils/fs'
import { parseIntegrity } from './integrity'
import { resolveLockedPluginPackage } from './package'
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

export function listMissing(
  config: ParsedStaticConfig,
  lock: ParsedPluginLockFile,
): StaticPluginReference[] {
  const missing: StaticPluginReference[] = []

  for (const group of config.groups) {
    for (const reference of group.plugins) {
      const entry = lock.find(reference)

      if (entry === undefined) {
        missing.push(reference)
      }
    }
  }

  return missing
}

export async function listUnresolved(
  config: ParsedStaticConfig,
  lock: ParsedPluginLockFile,
): Promise<ParsedPluginLockEntry[]> {
  const unresolved: ParsedPluginLockEntry[] = []
  const checkedEntries = new Set<ParsedPluginLockEntry>()

  for (const group of config.groups) {
    for (const reference of group.plugins) {
      const entry = lock.find(reference)

      if (entry === undefined || checkedEntries.has(entry)) {
        continue
      }

      checkedEntries.add(entry)

      try {
        await resolveLockedPluginPackage(entry)
      }
      catch {
        unresolved.push(entry)
      }
    }
  }

  return unresolved
}

export async function loadPluginLockFile(cwd: string): Promise<PluginLockFile> {
  try {
    return parsePluginLockFileValue(await readFile(getProjectPluginLockPath(cwd), 'utf8'))
  }
  catch (error) {
    if (isENOENTError(error)) {
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

export async function writePluginLockFile(cwd: string, lock: PluginLockFile): Promise<void> {
  const content = `${JSON.stringify(parsePluginLockFileValue(lock), null, 2)}\n`
  const lockPath = getProjectPluginLockPath(cwd)
  const lockDir = dirname(lockPath)
  const tempPath = join(lockDir, `lock.${randomUUID()}.tmp`)

  await mkdir(lockDir, { recursive: true })

  try {
    await writeFile(tempPath, content, 'utf8')
    await rename(tempPath, lockPath)
  }
  catch (error) {
    await rm(tempPath, { force: true })
    throw error
  }
}

function parsePluginLockFileValue(value: unknown): PluginLockFile {
  const parsedValue = typeof value === 'string' ? JSON.parse(value) as unknown : value
  const file = parse(PluginLockFileSchema, parsedValue)

  for (const [alias, entry] of Object.entries(file.plugins)) {
    if (entry.alias !== alias) {
      throw new Error(`Plugin lock entry key "${alias}" must match alias "${entry.alias}".`)
    }

    parseIntegrity(entry.integrity, entry.specifier)
  }

  return file
}
