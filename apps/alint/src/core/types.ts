import type { RunnerConfig, SetupConfig } from '../config/types'
import type { AlintConfig, DiagnosticLocation, RuleInferenceUsageRecord } from '../dsl/types'

export interface Diagnostic {
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

export type ProgressTargetKind = 'class' | 'file' | 'function'

export interface RuleEndPayload {
  cache: 'hit' | 'miss'
  endedAt?: number
  path: ProgressPath
  startedAt?: number
  state: 'completed' | 'errored'
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
  startedAt?: number
  usage: RunUsage
}

export interface RunnerOptions extends RunnerConfig {
  clock?: () => number
}

export interface RunOptions {
  config?: AlintConfig
  cwd?: string
  files?: string[]
  modelOverride?: string
  progress?: ProgressReporter
  runner?: RunnerOptions
  setupConfig?: SetupConfig
}

export interface RunResult {
  diagnostics: Diagnostic[]
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
