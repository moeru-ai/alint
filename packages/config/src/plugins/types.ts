import type { StaticPluginReference } from '../config/static'
import type { ParsedPluginSpecifier } from './spec'

export interface ParsedPluginLockEntry {
  alias: string
  cwd: string
  lockEntry: PluginLockEntry
  specifier: ParsedPluginSpecifier
}

export interface ParsedPluginLockFile {
  cwd: string
  entries: ParsedPluginLockEntry[]
  file: PluginLockFile
  find: (reference: StaticPluginReference) => ParsedPluginLockEntry | undefined
  get: (reference: StaticPluginReference) => ParsedPluginLockEntry
}

export interface PluginLockEntry {
  alias: string
  entry: string
  integrity: string
  name: string
  registry: string
  specifier: string
  tarball: string
  version: string
}

export interface PluginLockFile {
  plugins: Record<string, PluginLockEntry>
  version: 1
}
