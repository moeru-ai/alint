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
  /** Number of retries after an adapter explicitly declares an invocation safe to replay. Defaults to 2. */
  agentRetries?: number
  cache?: boolean | RunnerCacheConfig
  fileConcurrency?: number
  ruleConcurrency?: number
  stats?: boolean | RunnerStatsConfig
  timeoutMs?: number
}

export interface RunnerStatsConfig {
  enabled?: boolean
  location?: string
  retentionMonths?: number
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
