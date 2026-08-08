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

export type StopGateEnvelope
  = | StopGateEnvelopeBase & {
    findingsHash: string
    reportPath: string
    status: 'errors' | 'warnings'
  }
  | StopGateEnvelopeBase & {
    message: string
    status: 'runtime-error'
  }
  | StopGateEnvelopeBase & {
    status: 'clean'
  }
  | StopGateEnvelopeBase & {
    status: 'inactive'
  }
  | StopGateEnvelopeBase & {
    status: 'no-dirty-files'
  }

interface StopGateEnvelopeBase {
  errorCount: number
  schemaVersion: 2
  warningCount: number
}
