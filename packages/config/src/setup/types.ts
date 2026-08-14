import type {
  ProviderType,
  RunnerConfig,
  SetupModelDefinition,
} from '@alint-js/core'

export interface AcpModelConfig extends SetupModelDefinition {
  args?: string[]
  command: string
  cwd?: string
  driver: 'acp'
  env?: Record<string, string>
}

export type ModelConfig = AcpModelConfig | SetupModelDefinition

/** Raw setup-file provider. CLI model drivers are materialized before core receives it. */
export interface ProviderConfig {
  endpoint?: string
  headers?: Record<string, string>
  id: string
  models: ModelConfig[]
  type?: ProviderType
}

export interface SetupConfig {
  providers: ProviderConfig[]
  runner?: RunnerConfig
  tracing?: TracingConfig
  version: 1
}

export interface TracingConfig {
  captureLlmContent?: boolean
  directory?: string
  enabled?: boolean
}

export function isAcpModel(model: ModelConfig): model is AcpModelConfig {
  return 'driver' in model && model.driver === 'acp'
}

export function modelFromAcpModel(model: AcpModelConfig): SetupModelDefinition {
  const { args: _, command: _command, cwd: _cwd, driver: _driver, env: _env, ...definition } = model
  return definition
}
