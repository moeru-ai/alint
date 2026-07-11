import type { PluginDefinition } from '@alint-js/core'

export interface ParsedPluginSpecifier {
  name: string
  raw: string
  version: string
}

export interface PluginLockEntry {
  alias: string
  apiVersion: string
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

export interface StaticPluginReference {
  alias: string
  specifier: ParsedPluginSpecifier
}

export type StaticPluginResolver = (
  reference: StaticPluginReference,
) => Promise<PluginDefinition>
