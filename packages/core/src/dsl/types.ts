import type { GenericSchema, InferInput, InferOutput } from 'valibot'

import type { AgentAdapter } from '../agent/types'
import type { RunnerConfig } from '../config/types'
import type {
  BaseSourceFile,
  ClassTarget,
  FileTarget,
  FunctionTarget,
  LanguageContext,
  PlannedSourceTarget,
  ProcessedSource,
  ProcessorContext,
  ProcessorPostprocessContext,
  SourceFile,
  SourceRange,
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
  /**
   * How the run reports files it lints that no language claimed, so they were handled as plain
   * text. Defaults to `'warn'`. An explicit `language: 'plaintext'` pin means plain text was the
   * intent, so pinned files are never reported.
   */
  reportUnregisteredLanguages?: RuleSeverity
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
  /**
   * The language's id: what a config pins through `language:`, what a rule's `languages` lists, and
   * what every target it extracts reports. The registry is keyed by it, so two packs cannot claim
   * the same one.
   *
   * Use the identifier editors already use — `go`, `python`, `rust`, `typescript`, `plaintext` —
   * rather than inventing a spelling. Anyone can register a language, so the set is open by
   * definition and only a shared convention keeps one language from arriving under three names.
   *
   * NOTICE: the list is VS Code's. The Language Server Protocol shares it for the languages it
   * covers, but its table has no entry for plain text, so `plaintext` comes from VS Code alone.
   * https://code.visualstudio.com/docs/languages/identifiers
   * https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocumentItem
   */
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

export interface ProjectFileEntry extends BaseSourceFile {
  targetCount: number
}

export interface ProjectTarget {
  files: readonly ProjectFileEntry[]
  kind: 'project'
  root: string
  targets: readonly ProjectTargetEntry[]
}

export interface ProjectTargetEntry {
  filePath: string
  identity: string
  kind: string
  name?: string
  range?: SourceRange
}

export type RuleCacheConfig = boolean | { level?: 'target' }

export type RuleConfigEntry<
  Options extends readonly unknown[] = readonly [],
>
  = | readonly [RuleSeverity, ...Partial<Options>]
    | RuleSeverity

export interface RuleContext<
  Options extends readonly unknown[] = readonly [],
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
  /**
   * Which languages this rule reads. Omitting it opts out of extraction: the rule still receives
   * file targets, but never the function and class targets a language produces.
   *
   * It does not choose how a file is parsed. A config's `language:` pin, or the extension, settles
   * that before any rule is consulted. Directory and project targets ignore it too: they index a
   * tree rather than come from a language.
   */
  languages?: RuleLanguages
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

/**
 * - `'any'` — every registered language, and never a failure. A rule that works from `FunctionInfo`
 *   alone wants this: a language pack the user installs later is covered without a new release.
 * - A list of language ids — `LanguageDefinition.name` values such as `go` or `typescript`, never
 *   file extensions. The rule handles exactly these. Files of other languages are skipped
 *   rather than failed, so one plugin can carry rules for several languages behind one `files:`
 *   glob. If a listed language is not registered at all the run fails, because a rule scoped to a
 *   language nothing provides would otherwise skip every file in silence.
 * - `{ ids: string[], skipMissing?: boolean }` — the same scoping, but an unregistered id can be
 *   skipped instead of failing. For a plugin whose rules span languages a given user may not have installed.
 */
export type RuleLanguages
  = | 'any'
    | readonly string[]
    | {
      /** Language ids this rule applies to. */
      ids: readonly string[]
      /** Whether to skip unregistered languages instead of failing. */
      skipMissing?: boolean
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

export type Target = DirectoryTarget | PlannedSourceTarget | ProjectTarget
