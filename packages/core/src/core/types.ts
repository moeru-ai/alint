import type { RunnerConfig, SetupConfig } from '../config/types'
import type { AlintConfig, DiagnosticLocation, RuleInferenceUsageRecord } from '../dsl/types'
import type { SourceTargetKind } from './source/types'

export interface AlintRunFailure {
  kind: 'cache-replay' | 'handler' | 'timeout'
  message: string
  path: ProgressPath
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
  /** Complete snapshot projected in planned job order. */
  diagnostics: Diagnostic[]
  path?: ProgressPath
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

export interface PlanProgressPayload {
  endedAt?: number
  execution: ExecutionCounts
  plan: ProgressPlanRef
  startedAt?: number
}

export interface ProgressPath {
  job: {
    index: number
    total: number
  }
  plan: ProgressPlanRef
  rule: {
    id: string
    index: number
    total: number
  }
  target: {
    identity: string
    index: number
    kind: ProgressTargetKind
    name?: string
    total: number
  }
}

export type ProgressPlanKind = 'directory' | 'project' | 'source'

export interface ProgressPlanRef {
  id: string
  index: number
  kind: ProgressPlanKind
  path: string
  planned: number
  total: number
}

export interface ProgressReporter {
  onDiagnostic?: (payload: DiagnosticProgressPayload) => void
  onPlanEnd?: (payload: PlanProgressPayload) => void
  onPlanStart?: (payload: PlanProgressPayload) => void
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
  failure?: AlintRunFailure
  path: ProgressPath
  startedAt?: number
  state: 'cached' | 'cancelled' | 'completed' | 'failed' | 'skipped'
}

export interface RuleStartPayload {
  path: ProgressPath
  startedAt?: number
}

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
  execution: ExecutionCounts
  plans: ProgressPlanRef[]
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
  execution: ExecutionCounts
  path: ProgressPath
  startedAt?: number
}

export interface UsageProgressPayload {
  path?: ProgressPath
  record: InferenceUsageRecord
  /** Complete snapshot projected in planned job order. */
  total: RunUsage
}
