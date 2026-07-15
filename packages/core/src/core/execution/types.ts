import type { ExecutionTarget, RuleExecutionBucket, RuleTargetExecution, TargetExecutionPlan } from '../targets/types'
import type { AlintRunFailure, ProgressPath } from '../types'

export interface RuleExecutionJob {
  execution: RuleTargetExecution
  path: ProgressPath
  plan: TargetExecutionPlan
  target: ExecutionTarget
}

export type RuleExecutionOutcome = RuleExecutionOutcomeBase & (
  | { cache: 'hit', cause?: never, failure?: never, state: 'cached' }
  | { cache: 'hit' | 'miss', cause: unknown, failure: AlintRunFailure, state: 'failed' }
  | { cache: 'miss', cause?: never, failure?: never, state: 'cancelled' }
  | { cache: 'miss', cause?: never, failure?: never, state: 'completed' }
  | { cache: 'miss', cause?: never, failure?: never, state: 'skipped' }
)

interface RuleExecutionOutcomeBase {
  bucket: RuleExecutionBucket
  job: RuleExecutionJob
}
