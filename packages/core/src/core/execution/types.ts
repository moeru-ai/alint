import type { ExecutionTarget, RuleTargetExecution } from '../targets/types'
import type { AlintRunFailure, Diagnostic, InferenceUsageRecord, ProgressJob } from '../types'

export interface JobOrderKey {
  inputIndex: number
  ruleIndex: number
  scope: JobScope
  targetIndex: number
}

export type JobScope = 'directory' | 'project' | 'source'

export interface RuleJob {
  execution: RuleTargetExecution
  jobRef: ProgressJob
  orderKey: JobOrderKey
  target: ExecutionTarget
}

export type RuleJobOutcome = TerminalOutcome & {
  diagnostics: Diagnostic[]
  jobRef: ProgressJob
  orderKey: JobOrderKey
  usage: InferenceUsageRecord[]
}

export type TerminalOutcome
  = | { cache: 'hit', failure?: never, state: 'cached' }
    | { cache: 'hit' | 'miss', failure: AlintRunFailure, state: 'failed' }
    | { cache: 'miss', failure?: never, state: 'cancelled' }
    | { cache: 'miss', failure?: never, state: 'completed' }
    | { cache: 'miss', failure?: never, state: 'skipped' }
