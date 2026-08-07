export * from './config'
export {
  ignorePatternsAIAgents,
  ignorePatternsBuildOutputs,
  ignorePatternsCaches,
  ignorePatternsCommon,
  ignorePatternsEslintDefaults,
  ignorePatternsGenerated,
} from './constants/patterns/ignore'
export {
  getGlobalSetupConfigPath,
  getProjectPluginLockPath,
  getProjectPluginStorePath,
  getProjectSetupConfigPath,
  getStatsDir,
} from './paths'
export type { GlobalSetupConfigPathOptions } from './paths'
export * from './plugins'
export * from './setup'
export type { ProviderConfig as ProviderDefinition } from './setup/types'
export type {
  AlintConfig,
  ModelSize,
  ProviderType,
  RunnerConfig,
  RunnerStatsConfig,
  SetupModelDefinition,
} from '@alint-js/core'
