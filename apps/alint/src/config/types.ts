export type ModelSize = 'large' | 'medium' | 'small'

export interface ProviderDefinition {
  endpoint: string
  headers?: Record<string, string>
  id: string
  models: SetupModelDefinition[]
  type: ProviderType
}

export type ProviderType = 'openai-compatible'

export interface RunnerCacheConfig {
  enabled?: boolean
  location?: string
}

export interface RunnerConfig {
  cache?: boolean | RunnerCacheConfig
  fileConcurrency?: number
  ruleConcurrency?: number
  timeoutMs?: number
}

export interface SetupConfig {
  providers: ProviderDefinition[]
  runner?: RunnerConfig
  version: 1
}

export interface SetupModelDefinition {
  aliases?: string[]
  capabilities?: string[]
  contextWindow?: number
  defaultParams?: Record<string, unknown>
  id: string
  name?: string
  size?: ModelSize
}
