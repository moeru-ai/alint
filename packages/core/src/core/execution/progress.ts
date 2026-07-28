import type { ExecutionCounts, ProgressSnapshot } from '../types'

export interface RunProgress {
  completeFilePlanning: () => ProgressSnapshot
  completePlanning: () => ProgressSnapshot
  finalize: () => ProgressSnapshot
  finish: (from: ActiveState, to: TerminalState) => ProgressSnapshot
  queue: (count?: number) => ProgressSnapshot
  snapshot: () => ProgressSnapshot
  start: () => ProgressSnapshot
}
type ActiveState = 'queued' | 'running'

type TerminalState = 'cached' | 'cancelled' | 'completed' | 'failed' | 'skipped'

export function createRunProgress(filesTotal: number): RunProgress {
  assertNonNegativeInteger(filesTotal, 'File total')
  const execution = createCounts()
  let filesPlanned = 0
  let planningComplete = false

  const snapshot = (): ProgressSnapshot => {
    const jobsCompleted = terminalCount(execution)
    return {
      execution: { ...execution },
      filesPlanned,
      filesTotal,
      jobsCompleted,
      jobsStarted: jobsCompleted + execution.running,
      jobsTotal: execution.planned,
      planningComplete,
    }
  }

  return {
    completeFilePlanning: () => {
      if (planningComplete)
        throw new Error('Cannot complete file planning after planning is complete.')
      if (filesPlanned >= filesTotal)
        throw new Error('Cannot complete planning for more files than the file total.')
      filesPlanned += 1
      return snapshot()
    },
    completePlanning: () => {
      planningComplete = true
      return snapshot()
    },
    finalize: () => {
      if (execution.queued !== 0 || execution.running !== 0)
        throw new Error('Cannot finalize progress while jobs are queued or running.')
      if (!planningComplete)
        throw new Error('Cannot finalize progress before planning is complete.')
      return snapshot()
    },
    finish: (from, to) => {
      if (execution[from] <= 0)
        throw new Error(`Cannot finish a job without a ${from} job.`)
      execution[from] -= 1
      execution[to] += 1
      return snapshot()
    },
    queue: (count = 1) => {
      if (planningComplete)
        throw new Error('Cannot queue work after planning is complete.')
      assertNonNegativeInteger(count, 'Queued job count')
      assertSafeSum(execution.planned, count, 'Planned job count')
      assertSafeSum(execution.queued, count, 'Queued job count')
      execution.planned += count
      execution.queued += count
      return snapshot()
    },
    snapshot,
    start: () => {
      if (execution.queued <= 0)
        throw new Error('Cannot start a job without a queued job.')
      execution.queued -= 1
      execution.running += 1
      return snapshot()
    },
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`${name} must be a non-negative integer.`)
}

function assertSafeSum(left: number, right: number, name: string): void {
  if (!Number.isSafeInteger(left + right))
    throw new TypeError(`${name} must remain a safe integer.`)
}

function createCounts(): ExecutionCounts {
  return {
    cached: 0,
    cancelled: 0,
    completed: 0,
    failed: 0,
    planned: 0,
    queued: 0,
    running: 0,
    skipped: 0,
  }
}

function terminalCount(execution: ExecutionCounts): number {
  return execution.cached
    + execution.cancelled
    + execution.completed
    + execution.failed
    + execution.skipped
}
