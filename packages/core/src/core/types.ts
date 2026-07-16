import type { RunnerConfig, SetupConfig } from '../config/types'
import type { AlintConfig, DiagnosticLocation, RuleInferenceUsageRecord } from '../dsl/types'
import type { SourceTargetKind } from './source/types'

export interface AlintRunFailure {
  job: ProgressJob
  kind: 'cache-replay' | 'handler' | 'timeout'
  message: string
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
  job: ProgressJob
}

export interface ExecutionCounts {
  cached: number
  cancelled: number
  completed: number
  failed: number
  planned: number
  queued: number
  running: number
  /** Rules left unexecuted because they missed the cache under {@link RunOptions.cacheOnly}. */
  skipped: number
}

export type InferenceUsageRecord = Omit<RuleInferenceUsageRecord, 'ruleId'> & {
  ruleId: string
}

export interface JobEndPayload extends JobStartPayload {
  cache: 'hit' | 'miss'
  endedAt?: number
  failure?: AlintRunFailure
  state: 'cached' | 'cancelled' | 'completed' | 'failed' | 'skipped'
}

export interface JobQueuedPayload {
  job: ProgressJob
}

export interface JobStartPayload {
  job: ProgressJob
  startedAt?: number
}

export interface ProgressJob {
  id: string
  index: number
  inputPath: string
  ruleId: string
  target: {
    identity: string
    kind: ProgressTargetKind
    name?: string
  }
  total: number
}

export interface ProgressReporter {
  onDiagnostic?: (payload: DiagnosticProgressPayload) => void
  onJobEnd?: (payload: JobEndPayload) => void
  onJobQueued?: (payload: JobQueuedPayload) => void
  onJobStart?: (payload: JobStartPayload) => void
  onRunEnd?: (payload: RunEndPayload) => void
  onRunStart?: (payload: RunStartPayload) => void
  onUsage?: (payload: UsageProgressPayload) => void
}

export type ProgressTargetKind = SourceTargetKind

export interface RunEndPayload {
  diagnostics: Diagnostic[]
  endedAt?: number
  execution: ExecutionCounts
  startedAt?: number
  usage: RunUsage
}

export type RunExecution = ExecutionCounts

export type RunnerOptions = RunnerConfig

export interface RunOptions {
  /**
   * Return only diagnostics that are already cached, without calling any model.
   * Rules that miss the cache are skipped, and the cache remains read-only.
   */
  cacheOnly?: boolean
  config?: AlintConfig
  cwd?: string
  directories?: string[]
  files?: string[]
  modelOverride?: string
  outputLanguage?: string
  progress?: ProgressReporter
  /**
   * Run project-scoped rules (`onTargetProject` and the project pass of `onTargetWith`).
   * Defaults to `true`. Pass `false` for runs that target partial subsets of a project.
   */
  projectTargets?: boolean
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
  execution: ExecutionCounts
  usage: RunUsage
}

export interface RunStartPayload {
  jobsTotal: number
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

export interface UsageProgressPayload {
  job: ProgressJob
  record: InferenceUsageRecord
}
