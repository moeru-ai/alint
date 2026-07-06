export { hasDiscoveryFilePatterns, matchesDiscoveryFile, normalizeConfig, resolveConfigForFile } from './config/config-array'
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
export { extractJsSourceTargets } from './core/languages/js/extract'
export { AlintRunError, runAlint } from './core/run'
export { createSourceFile, createSourceRuntime, sliceLines, sliceRange } from './core/source/runtime'
export type {
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
  SourceTargetOrigin,
  SourceText,
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
  AlintConfigExtends,
  AlintConfigInput,
  AlintConfigItem,
  AlintLinterOptions,
  Awaitable,
  DiagnosticDescriptor,
  DiagnosticLocation,
  EnabledRule,
  IgnoreConfig,
  LanguageDefinition,
  PluginDefinition,
  ProcessorDefinition,
  RuleCacheConfig,
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
