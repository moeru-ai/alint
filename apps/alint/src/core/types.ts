import type { RunnerConfig, SetupConfig } from '../config/types'
import type { AlintConfig, DiagnosticLocation, RuleInferenceUsageRecord } from '../dsl/types'

export interface AlintDiagnosticProgressPayload {
  diagnostic: Diagnostic
  diagnostics: Diagnostic[]
  path?: AlintProgressPath
}

export interface AlintFileProgressPayload {
  endedAt?: number
  file: AlintProgressFilePath
  startedAt?: number
}

export interface AlintProgressFilePath {
  index: number
  path: string
  planned?: number
  total: number
}

export interface AlintProgressPath {
  file: AlintProgressFilePath
  rule: {
    id: string
    index: number
    total: number
  }
  target: {
    index: number
    kind: AlintProgressTargetKind
    name?: string
    total: number
  }
}

export interface AlintProgressReporter {
  onDiagnostic?: (payload: AlintDiagnosticProgressPayload) => void
  onFileEnd?: (payload: AlintFileProgressPayload) => void
  onFileStart?: (payload: AlintFileProgressPayload) => void
  onRuleEnd?: (payload: AlintRuleEndPayload) => void
  onRuleStart?: (payload: AlintRuleStartPayload) => void
  onRunEnd?: (payload: AlintRunEndPayload) => void
  onRunStart?: (payload: AlintRunStartPayload) => void
  onTargetEnd?: (payload: AlintTargetProgressPayload) => void
  onTargetStart?: (payload: AlintTargetProgressPayload) => void
  onUsage?: (payload: AlintUsageProgressPayload) => void
}

export type AlintProgressTargetKind = 'class' | 'file' | 'function'

export interface AlintRuleEndPayload {
  cache: 'hit' | 'miss'
  endedAt?: number
  path: AlintProgressPath
  startedAt?: number
  state: 'completed' | 'errored'
}

export interface AlintRuleStartPayload {
  path: AlintProgressPath
  startedAt?: number
}

export interface AlintRunEndPayload {
  cached: number
  completed: number
  diagnostics: Diagnostic[]
  endedAt?: number
  errored: number
  planned: number
  startedAt?: number
  usage: RunAlintUsage
}

export interface AlintRunStartPayload {
  files?: AlintProgressFilePath[]
  filesTotal: number
  planned: number
  rulesTotal: number
  startedAt?: number
}

export interface AlintTargetProgressPayload {
  endedAt?: number
  path: AlintProgressPath
  startedAt?: number
}

export interface AlintUsageProgressPayload {
  path?: AlintProgressPath
  record: InferenceUsageRecord
  total: RunAlintUsage
}

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

export type InferenceUsageRecord = Omit<RuleInferenceUsageRecord, 'ruleId'> & {
  ruleId: string
}

export interface RunAlintOptions {
  config?: AlintConfig
  cwd?: string
  files?: string[]
  modelOverride?: string
  progress?: AlintProgressReporter
  runner?: RunnerOptions
  setupConfig?: SetupConfig
}

export interface RunAlintResult {
  diagnostics: Diagnostic[]
  usage: RunAlintUsage
}

export interface RunAlintUsage {
  inputTokens: number
  outputTokens: number
  records: InferenceUsageRecord[]
  totalTokens: number
}

export interface RunnerOptions extends RunnerConfig {
  clock?: () => number
}
