export {
  hasDiscoveryFilePatterns,
  matchesDiscoveryFile,
  normalizeConfig,
  resolveConfigForDirectory,
  resolveConfigForFile,
  resolveConfigForProject,
} from './config/config-array'
export type { EffectiveAlintConfig, ResolveConfigResult } from './config/config-array'
export {
  defaultStopGateConfig,
  maximumStopGateTimeoutMs,
  resolveStopGateConfig,
} from './config/stop-gate'
export type { ResolvedStopGateConfig } from './config/stop-gate'
export type {
  ModelSize,
  ProviderDefinition,
  ProviderType,
  RunnerConfig,
  RunnerStatsConfig,
  SetupConfig,
  SetupModelDefinition,
} from './config/types'
export { stableHash } from './core/hash'
export {
  createBuiltInLanguageRegistry,
  registerLanguage,
  resolveLanguage,
} from './core/languages'
export type { LanguageRegistry, ResolveLanguageOptions } from './core/languages'
export { createSourceExtractor } from './core/preparation'
export { AlintAbortError, AlintCachePersistenceError, AlintRunCancelledError, AlintRunError, runAlint } from './core/run'
export { targetIdentity, withStableIdentities } from './core/source/identity'
export { createSourceFile, createSourceRuntime, sliceLines, sliceRange, withLanguage } from './core/source/runtime'
export type { SourceRuntimeOptions } from './core/source/runtime'
export type {
  BaseSourceFile,
  CallSite,
  ClassTarget,
  FileTarget,
  FunctionInfo,
  FunctionTarget,
  LanguageContext,
  LineRange,
  PlannedSourceTarget,
  PlannedSourceTargetOfKind,
  ProcessedSource,
  ProcessedSourceOrigin,
  ProcessorContext,
  ProcessorPostprocessContext,
  SourceExtractOptions,
  SourceFile,
  SourceLocation,
  SourceMetadataObject,
  SourceMetadataValue,
  SourcePosition,
  SourceRange,
  SourceRuntime,
  SourceTarget,
  SourceTargetKind,
  SourceTargetMetadata,
  SourceTargetOfKind,
  SourceTargetOrigin,
  SourceText,
} from './core/source/types'
export type {
  AlintFailureCause,
  AlintFileFailure,
  AlintRuleFailure,
  AlintRunFailure,
  Diagnostic,
  DiagnosticProgressPayload,
  ExecutionCounts,
  ExecutionProgressPayload,
  FileReadyPayload,
  InferenceUsageRecord,
  JobEndPayload,
  JobQueuedPayload,
  JobRetryPayload,
  JobStartPayload,
  PrepareEndPayload,
  PrepareStartPayload,
  ProgressJobRef,
  ProgressReporter,
  ProgressSnapshot,
  ProgressTargetKind,
  RunEndPayload,
  RunExecution,
  RunOptions,
  RunResult,
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
  IntegrationsConfig,
  LanguageDefinition,
  PluginDefinition,
  ProcessorDefinition,
  ProjectFileEntry,
  ProjectTarget,
  ProjectTargetEntry,
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
  StopGateConfig,
  StopGateTarget,
  Target,
} from './dsl/types'
export { benchmarkModels } from './models/benchmark'
export type {
  BenchmarkModelsOptions,
  ModelBenchmarkActive,
  ModelBenchmarkMeasurement,
  ModelBenchmarkProgress,
  ModelBenchmarkRequest,
  ModelBenchmarkResult,
} from './models/benchmark'
export { resolveModel } from './models/resolve'
export type { ModelRequirement, ResolvedModel, ResolvedProvider, ResolveModelOptions } from './models/types'
