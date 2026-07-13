export interface DeclarativePluginImportTarget {
  alias: string
  cache: 'content'
  entry: string
  kind: 'declarative'
}

export interface ModulePluginImportTarget {
  alias: string
  cache: 'content' | 'default'
  entry: string
  kind: 'module'
}

export type PluginImportTarget = DeclarativePluginImportTarget | ModulePluginImportTarget
