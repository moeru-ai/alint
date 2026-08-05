export interface FindingSummary {
  errorCount: number
  findingsHash: string
  reportPath: string
  status: 'errors' | 'warnings'
  warningCount: number
}

export interface HookDecision {
  decision?: 'block'
  reason?: string
  systemMessage?: string
}

export interface HookInput {
  cwd?: string
  hook_event_name?: string
  session_id?: string
  stop_hook_active?: boolean
  turn_id?: string
}

export interface SessionState {
  lastFindings?: FindingSummary
  lintRounds: number
  runtimeFailures: number
  schemaVersion: 2
  updatedAt: string
}

export interface StopGateEnvelope {
  errorCount: number
  findingsHash?: string
  message?: string
  reportPath?: string
  schemaVersion: 2
  status: StopGateStatus
  warningCount: number
}

export type StopGateStatus
  = | 'clean'
    | 'errors'
    | 'inactive'
    | 'no-dirty-files'
    | 'runtime-error'
    | 'warnings'
