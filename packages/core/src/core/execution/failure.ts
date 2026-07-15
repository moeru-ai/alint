import type { AlintRunFailure } from '../types'

export type TerminalFailure
  = | { cause: unknown, failures: AlintRunFailure[], kind: 'cancelled' | 'infrastructure' | 'progress' }
    | { causes: unknown[], failures: AlintRunFailure[], kind: 'rules' }

export interface TerminalFailureInput {
  cancellationCause: unknown
  cancelled: boolean
  failedOutcomeCauses: unknown[]
  failures: AlintRunFailure[]
  infrastructureCause: unknown
  infrastructureFailed: boolean
  progressCause: unknown
  progressFailed: boolean
}

export function selectTerminalFailure(input: TerminalFailureInput): TerminalFailure | undefined {
  if (input.progressFailed)
    return { cause: input.progressCause, failures: input.failures, kind: 'progress' }
  if (input.cancelled)
    return { cause: input.cancellationCause, failures: input.failures, kind: 'cancelled' }
  if (input.infrastructureFailed)
    return { cause: input.infrastructureCause, failures: input.failures, kind: 'infrastructure' }
  if (input.failures.length > 0) {
    return {
      causes: input.failedOutcomeCauses.filter(cause => cause !== undefined),
      failures: input.failures,
      kind: 'rules',
    }
  }
}
