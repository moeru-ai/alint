export { executeCli } from './cli'
export type { CliIo } from './cli'

export { formatDiagnostics } from './cli/reporters'
export type { ReporterName } from './cli/reporters'

export { formatJson } from './cli/reporters/json'

export { formatStylish } from './cli/reporters/stylish'

export { loadAlintConfig } from './config/load-config'
export { getGlobalSetupConfigPath, getProjectSetupConfigPath } from './config/paths'

export { emptySetupConfig, loadSetupConfig, mergeSetupConfigs } from './config/setup-load'
export { parseSetupConfigToml, stringifySetupConfigToml } from './config/setup-toml'

export { writeSetupConfig } from './config/setup-write'
export type {
  ModelSize,
  ProviderDefinition,
  ProviderType,
  SetupConfig,
  SetupModelDefinition,
} from './config/types'

export { runAlint } from './core/run'
export { extractJsSourceUnits } from './core/source/js'

export { createSourceFile, createSourceRuntime, sliceLines, sliceRange } from './core/source/runtime'
export type {
  ClassUnit,
  FunctionUnit,
  LineRange,
  SourceFile,
  SourceLocation,
  SourcePosition,
  SourceRange,
  SourceRuntime,
  SourceText,
  SourceUnit,
} from './core/source/types'
export type {
  Diagnostic,
  DiagnosticProgressPayload,
  FileProgressPayload,
  InferenceUsageRecord,
  ProgressFilePath,
  ProgressPath,
  ProgressReporter,
  ProgressTargetKind,
  RuleEndPayload,
  RuleStartPayload,
  RunEndPayload,
  RunOptions,
  RunResult,
  RunStartPayload,
  RunUsage,
  TargetProgressPayload,
  UsageProgressPayload,
} from './core/types'

export { defineConfig, definePlugin, defineRule } from './dsl/define'
export { buildRuleRegistry } from './dsl/registry'

export type {
  AlintConfig,
  Awaitable,
  DiagnosticDescriptor,
  DiagnosticLocation,
  EnabledRule,
  PluginDefinition,
  RuleConfigEntry,
  RuleContext,
  RuleDefinition,
  RuleHandlers,
  RuleInferenceUsageRecord,
  RuleRegistry,
  RuleSeverity,
} from './dsl/types'
export { resolveModel } from './models/resolve'

export type { ModelRequirement, ResolvedModel, ResolvedProvider, ResolveModelOptions } from './models/types'
