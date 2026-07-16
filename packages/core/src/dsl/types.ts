import type { GenericSchema, InferInput, InferOutput } from 'valibot'

import type { AgentAdapter } from '../agent/types'
import type { RunnerConfig } from '../config/types'
import type {
  ClassTarget,
  FileTarget,
  FunctionTarget,
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
  directories?: readonly (readonly string[] | string)[]
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

export interface DirectoryTarget {
  kind: 'directory'
  path: string
}

export interface EnabledRule {
  id: string
  localId: string
  options: readonly unknown[]
  rule: RuleDefinition<any>
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

export interface PluginDefinition<
  Rules extends Record<string, RuleDefinition<any>> = Record<string, RuleDefinition<any>>,
> {
  configs?: Record<string, AlintConfigInput>
  languages?: Record<string, LanguageDefinition>
  processors?: Record<string, ProcessorDefinition>
  rules?: Rules
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

export interface ProjectTarget {
  files: SourceFile[]
  kind: 'project'
  root: string
  targets: SourceTarget[]
}

export type RuleCacheConfig = boolean | { level?: 'target' }

export type RuleConfigEntry<
  Options extends readonly unknown[] = readonly [],
>
  = | readonly [RuleSeverity, ...Options]
    | RuleSeverity

export interface RuleContext<
  Options extends readonly unknown[] = readonly unknown[],
> {
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
  options: Options
  outputLanguage?: string
  report: (diagnostic: DiagnosticDescriptor) => void
  settings: Record<string, unknown>
  /**
   * Cancels the run. Forward it to anything long-running a rule starts, so cancelling stops
   * the work instead of letting it finish and bill.
   *
   * `ctx.agent` already injects it, and `generateStructured` accepts it as `signal`.
   */
  signal?: AbortSignal
  src: SourceRuntime
}

export interface RuleDefinition<
  OptionsSchema extends RuleOptionsSchema = [],
> {
  cache?: RuleCacheConfig
  /** Additional stable rule inputs, such as imported prompts, that invalidate cached results when changed. */
  cacheKey?: unknown
  create: (context: RuleContext<RuleOptionsOutput<OptionsSchema>>) => RuleHandlers
  model?: ModelRequirement
  options?: OptionsSchema
}

export type RuleHandlers = RuleSpecializedHandlers | RuleWithHandler

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

export type RuleOptionsInput<OptionsSchema extends RuleOptionsSchema>
  = { readonly [Index in keyof OptionsSchema]: InferInput<OptionsSchema[Index]> }

export type RuleOptionsOutput<OptionsSchema extends RuleOptionsSchema>
  = { readonly [Index in keyof OptionsSchema]: InferOutput<OptionsSchema[Index]> }

export type RuleOptionsSchema = readonly GenericSchema[]

export interface RuleRegistry {
  enabledRules: EnabledRule[]
  rules: Map<string, RuleDefinition<any>>
}

export type RuleSeverity = 'error' | 'off' | 'warn'

export interface RuleSpecializedHandlers {
  onTargetClass?: (target: ClassTarget) => Awaitable<void>
  onTargetDirectory?: (target: DirectoryTarget) => Awaitable<void>
  onTargetFile?: (target: FileTarget) => Awaitable<void>
  onTargetFunction?: (target: FunctionTarget) => Awaitable<void>
  onTargetProject?: (target: ProjectTarget) => Awaitable<void>
  onTargetWith?: never
}

export interface RuleWithHandler {
  onTargetClass?: never
  onTargetDirectory?: never
  onTargetFile?: never
  onTargetFunction?: never
  onTargetProject?: never
  onTargetWith: (target: Target) => Awaitable<void>
}

export type Target = DirectoryTarget | ProjectTarget | SourceTarget
