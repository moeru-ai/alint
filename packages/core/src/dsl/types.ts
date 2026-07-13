import type { AgentAdapter } from '../agent/types'
import type { RunnerConfig } from '../config/types'
import type {
  LanguageContext,
  ProcessedSource,
  ProcessorContext,
  ProcessorPostprocessContext,
  SourceFile,
  SourceRuntime,
  SourceTarget,
} from '../core/source/types'
import type { ModelRequirement, ResolvedModel } from '../models/types'

export type AlintConfig = readonly AlintConfigInput[]

export type AlintConfigExtends = AlintConfigInput | string

export type AlintConfigInput = AlintConfigItem | readonly AlintConfigInput[]

export interface AlintConfigItem {
  agent?: AgentAdapter
  basePath?: string
  extends?: readonly AlintConfigExtends[]
  files?: readonly (readonly string[] | string)[]
  ignore?: IgnoreConfig
  ignores?: readonly string[]
  language?: string
  languageOptions?: Record<string, unknown>
  linterOptions?: AlintLinterOptions
  name?: string
  plugins?: Record<string, PluginDefinition>
  processor?: ProcessorDefinition | string
  rules?: Record<string, RuleConfigEntry>
  runner?: RunnerConfig
  settings?: Record<string, unknown>
}

export interface AlintLinterOptions {
  noInlineConfig?: boolean
  reportUnusedDisableDirectives?: RuleSeverity
}

export type Awaitable<T> = Promise<T> | T

export interface DiagnosticDescriptor {
  evidence?: unknown
  filePath?: string
  loc?: DiagnosticLocation
  message: string
}

export interface DiagnosticLocation {
  end?: { column: number, line: number }
  start: { column: number, line: number }
}

export interface EnabledRule {
  id: string
  localId: string
  rule: RuleDefinition
  severity: Exclude<RuleSeverity, 'off'>
}

export interface IgnoreConfig {
  gitignore?: boolean
}

export interface LanguageDefinition {
  extensions?: readonly string[]
  extract: (file: SourceFile, context: LanguageContext) => Awaitable<SourceTarget[]>
  name: string
}

export interface PluginDefinition {
  configs?: Record<string, AlintConfigInput>
  languages?: Record<string, LanguageDefinition>
  processors?: Record<string, ProcessorDefinition>
  rules?: Record<string, RuleDefinition>
}

export interface ProcessorDefinition {
  postprocess?: (
    diagnostics: DiagnosticDescriptor[],
    context: ProcessorPostprocessContext,
  ) => Awaitable<DiagnosticDescriptor[]>
  preprocess: (
    file: SourceFile,
    context: ProcessorContext,
  ) => Awaitable<ProcessedSource[]>
}

export type RuleCacheConfig = boolean | { level?: 'target' }

export type RuleConfigEntry = [RuleSeverity] | RuleSeverity

export interface RuleContext {
  agent?: AgentAdapter
  cwd: string
  id: string
  localId: string
  logger: {
    debug: (...args: unknown[]) => void
  }
  metering: {
    recordUsage: (usage: RuleInferenceUsageRecord) => void
  }
  model: (selector?: ModelRequirement | string) => Promise<ResolvedModel>
  outputLanguage?: string
  report: (diagnostic: DiagnosticDescriptor) => void
  settings: Record<string, unknown>
  src: SourceRuntime
}

export interface RepositoryTarget {
  files: SourceFile[]
  targets: SourceTarget[]
}

export interface RuleDefinition {
  cache?: RuleCacheConfig
  create: (context: RuleContext) => RuleHandlers
  // TODO: Add `meta.languages` so rules can opt into specific alint languages.
  model?: ModelRequirement
}

export interface RuleHandlers {
  onRepository?: (repository: RepositoryTarget) => Awaitable<void>
  onTarget?: (target: SourceTarget) => Awaitable<void>
}

export interface RuleInferenceUsageRecord {
  filePath?: string
  inputTokens?: number
  metadata?: unknown
  modelId: string
  outputTokens?: number
  providerId: string
  ruleId?: string
  totalTokens?: number
}

export interface RuleRegistry {
  enabledRules: EnabledRule[]
  rules: Map<string, RuleDefinition>
}

export type RuleSeverity = 'error' | 'off' | 'warn'
