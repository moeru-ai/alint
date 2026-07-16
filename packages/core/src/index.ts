export {
  hasDiscoveryFilePatterns,
  matchesDiscoveryFile,
  normalizeConfig,
  resolveConfigForDirectory,
  resolveConfigForFile,
  resolveConfigForProject,
} from './config/config-array'
export type { EffectiveAlintConfig, ResolveConfigResult } from './config/config-array'
export type {
  ModelSize,
  ProviderDefinition,
  ProviderType,
  RunnerConfig,
  RunnerStatsConfig,
  SetupConfig,
  SetupModelDefinition,
} from './config/types'
export {
  createBuiltInLanguageRegistry,
  registerLanguage,
  resolveLanguage,
} from './core/languages'
export type { LanguageRegistry, ResolveLanguageOptions } from './core/languages'
export { AlintAbortError, AlintRunCancelledError, AlintRunError, runAlint } from './core/run'
export { createSourceFile, createSourceRuntime, sliceLines, sliceRange } from './core/source/runtime'
export type {
  ClassTarget,
  FileTarget,
  FunctionTarget,
  LanguageContext,
  LineRange,
  ProcessedSource,
  ProcessedSourceOrigin,
  ProcessorContext,
  ProcessorPostprocessContext,
  SourceFile,
  SourceLocation,
  SourcePosition,
  SourceRange,
  SourceRuntime,
  SourceTarget,
  SourceTargetKind,
  SourceTargetOfKind,
  SourceTargetOrigin,
  SourceText,
} from './core/source/types'
export type {
  AlintRunFailure,
  Diagnostic,
  DiagnosticProgressPayload,
  ExecutionCounts,
  InferenceUsageRecord,
  JobEndPayload,
  JobQueuedPayload,
  JobStartPayload,
  ProgressJob,
  ProgressReporter,
  ProgressTargetKind,
  RunEndPayload,
  RunExecution,
  RunOptions,
  RunResult,
  RunStartPayload,
  RunUsage,
  RunUsageTotals,
  UsageProgressPayload,
} from './core/types'
export { defineConfig, definePlugin, defineRule } from './dsl/define'
export { buildRuleRegistry } from './dsl/registry'
export type {
  AlintConfig,
  AlintConfigExtends,
  AlintConfigInput,
  AlintConfigItem,
  AlintLinterOptions,
  Awaitable,
  DiagnosticDescriptor,
  DiagnosticLocation,
  DirectoryTarget,
  EnabledRule,
  IgnoreConfig,
  LanguageDefinition,
  PluginDefinition,
  ProcessorDefinition,
  ProjectTarget,
  RuleCacheConfig,
  RuleConfigEntry,
  RuleContext,
  RuleDefinition,
  RuleHandlers,
  RuleInferenceUsageRecord,
  RuleRegistry,
  RuleSeverity,
  RuleSpecializedHandlers,
  RuleWithHandler,
  Target,
} from './dsl/types'
export { resolveModel } from './models/resolve'
export type { ModelRequirement, ResolvedModel, ResolvedProvider, ResolveModelOptions } from './models/types'
