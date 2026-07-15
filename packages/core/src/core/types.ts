import type { RunnerConfig, SetupConfig } from '../config/types'
import type { AlintConfig, DiagnosticLocation, RuleInferenceUsageRecord } from '../dsl/types'
import type { SourceTargetKind } from './source/types'

export interface AlintRunFailure {
  filePath?: string
  message: string
  ruleId?: string
  target?: {
    kind: ProgressTargetKind
    name?: string
  }
}

export interface Diagnostic {
  cached?: boolean
  evidence?: unknown
  filePath: string
  loc?: DiagnosticLocation
  message: string
  model?: {
    providerId: string
    requested?: string
    resolvedId: string
  }
  ruleId: string
  severity: 'error' | 'warn'
}

export interface DiagnosticProgressPayload {
  diagnostic: Diagnostic
  diagnostics: Diagnostic[]
  path?: ProgressPath
}

export interface FileProgressPayload {
  endedAt?: number
  file: ProgressFilePath
  startedAt?: number
}

export type InferenceUsageRecord = Omit<RuleInferenceUsageRecord, 'ruleId'> & {
  ruleId: string
}

export interface ProgressFilePath {
  index: number
  path: string
  planned?: number
  total: number
}

export interface ProgressPath {
  file: ProgressFilePath
  rule: {
    id: string
    index: number
    total: number
  }
  target: {
    index: number
    kind: ProgressTargetKind
    name?: string
    total: number
  }
}

export interface ProgressReporter {
  onDiagnostic?: (payload: DiagnosticProgressPayload) => void
  onFileEnd?: (payload: FileProgressPayload) => void
  onFileStart?: (payload: FileProgressPayload) => void
  onRuleEnd?: (payload: RuleEndPayload) => void
  onRuleStart?: (payload: RuleStartPayload) => void
  onRunEnd?: (payload: RunEndPayload) => void
  onRunStart?: (payload: RunStartPayload) => void
  onTargetEnd?: (payload: TargetProgressPayload) => void
  onTargetStart?: (payload: TargetProgressPayload) => void
  onUsage?: (payload: UsageProgressPayload) => void
}

export type ProgressTargetKind = SourceTargetKind

export interface RuleEndPayload {
  cache: 'hit' | 'miss'
  endedAt?: number
  path: ProgressPath
  startedAt?: number
  /**
   * `skipped` only occurs under {@link RunOptions.cacheOnly}: the rule missed the cache and was
   * never executed, so it produced no diagnostics. `cache` is still `'miss'` in that case.
   */
  state: 'completed' | 'errored' | 'skipped'
}

export interface RuleStartPayload {
  path: ProgressPath
  startedAt?: number
}

export interface RunEndPayload {
  cached: number
  completed: number
  diagnostics: Diagnostic[]
  endedAt?: number
  errored: number
  planned: number
  /** Rules left unexecuted because they missed the cache under {@link RunOptions.cacheOnly}. Always 0 otherwise. */
  skipped: number
  startedAt?: number
  usage: RunUsage
}

export interface RunExecution {
  cached: number
  completed: number
  errored: number
  planned: number
  /** Rules left unexecuted because they missed the cache under {@link RunOptions.cacheOnly}. Always 0 otherwise. */
  skipped: number
}

export type RunnerOptions = RunnerConfig

export interface RunOptions {
  /**
   * Return only diagnostics that are already cached, without calling any model.
   *
   * Rules that miss the cache are skipped instead of executed, and the run leaves the cache
   * file untouched. Read {@link RunExecution.skipped} to see how many rules a full run would
   * still have to execute.
   *
   * Intended for callers that want to show known results for free, such as an editor
   * displaying diagnostics on file open.
   */
  cacheOnly?: boolean
  config?: AlintConfig
  cwd?: string
  directories?: string[]
  files?: string[]
  modelOverride?: string
  outputLanguage?: string
  progress?: ProgressReporter
  runner?: RunnerOptions
  setupConfig?: SetupConfig
  /**
   * Cancels the run. Aborting stops the engine from starting further rules and cancels the
   * in-flight model call, so a cancelled run stops spending tokens.
   *
   * `runAlint` rejects with {@link AlintAbortError}, which carries the diagnostics gathered
   * before the abort. Rules that already finished keep their cache entries: cancelling never
   * throws away work you already paid for.
   */
  signal?: AbortSignal
}

export interface RunResult {
  diagnostics: Diagnostic[]
  execution?: RunExecution
  usage: RunUsage
}

export interface RunStartPayload {
  files?: ProgressFilePath[]
  filesTotal: number
  planned: number
  rulesTotal: number
  startedAt?: number
}

export interface RunUsage {
  cached?: RunUsageTotals
  inputTokens: number
  outputTokens: number
  records: InferenceUsageRecord[]
  totalTokens: number
}

export interface RunUsageTotals {
  inputTokens: number
  outputTokens: number
  records: InferenceUsageRecord[]
  totalTokens: number
}

export interface TargetProgressPayload {
  endedAt?: number
  path: ProgressPath
  startedAt?: number
}

export interface UsageProgressPayload {
  path?: ProgressPath
  record: InferenceUsageRecord
  total: RunUsage
}
