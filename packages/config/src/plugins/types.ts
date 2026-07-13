import type { StaticPluginReference } from '../config/static'
import type { DirectoryPluginSpecifier, RegistryPluginSpecifier } from './spec'

export interface DirectoryPluginLockEntry {
  alias: string
  path: string
  specifier: string
  type: 'directory'
}

export interface ParsedDirectoryPluginLockEntry {
  alias: string
  cwd: string
  lockEntry: DirectoryPluginLockEntry
  resolutionError?: unknown
  specifier: DirectoryPluginSpecifier
  type: 'directory'
}

export type ParsedPluginLockEntry = ParsedDirectoryPluginLockEntry | ParsedRegistryPluginLockEntry

export interface ParsedPluginLockFile {
  cwd: string
  entries: ParsedPluginLockEntry[]
  file: PluginLockFile
  find: (reference: StaticPluginReference) => ParsedPluginLockEntry | undefined
  get: (reference: StaticPluginReference) => ParsedPluginLockEntry
}

export interface ParsedRegistryPluginLockEntry {
  alias: string
  cwd: string
  lockEntry: RegistryPluginLockEntry
  resolutionError?: unknown
  specifier: RegistryPluginSpecifier
  type: 'registry'
}

export type PluginLockEntry = DirectoryPluginLockEntry | RegistryPluginLockEntry

export interface PluginLockFile {
  plugins: Record<string, PluginLockEntry>
  version: 2
}

export interface RegistryPluginLockEntry {
  alias: string
  entry: string
  integrity: string
  name: string
  registry: string
  specifier: string
  tarball: string
  type: 'registry'
  version: string
}

export interface StaticPluginInstallOptions {
  configFile?: string
  cwd: string
  registry?: string
}

export interface StaticPluginInstallResult {
  configuredPluginCount: number
  installedLocalDirectoryCount: number
  installedPackageCount: number
  lock: PluginLockFile
}
