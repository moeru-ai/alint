import type { ExecutionCounts, ProgressSnapshot } from '../types'

export interface RunProgress {
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
  let final = false

  const snapshot = (): ProgressSnapshot => {
    const jobsCompleted = terminalCount(execution)
    return {
      execution: { ...execution },
      filesTotal,
      final,
      jobsCompleted,
      jobsStarted: jobsCompleted + execution.running,
      jobsTotal: execution.planned,
    }
  }

  return {
    finalize: () => {
      if (execution.queued !== 0 || execution.running !== 0)
        throw new Error('Cannot finalize progress while jobs are queued or running.')
      final = true
      return snapshot()
    },
    finish: (from, to) => {
      assertMutable(final)
      if (execution[from] <= 0)
        throw new Error(`Cannot finish a job without a ${from} job.`)
      execution[from] -= 1
      execution[to] += 1
      return snapshot()
    },
    queue: (count = 1) => {
      assertMutable(final)
      assertNonNegativeInteger(count, 'Queued job count')
      assertSafeSum(execution.planned, count, 'Planned job count')
      assertSafeSum(execution.queued, count, 'Queued job count')
      execution.planned += count
      execution.queued += count
      return snapshot()
    },
    snapshot,
    start: () => {
      assertMutable(final)
      if (execution.queued <= 0)
        throw new Error('Cannot start a job without a queued job.')
      execution.queued -= 1
      execution.running += 1
      return snapshot()
    },
  }
}

function assertMutable(final: boolean): void {
  if (final)
    throw new Error('Cannot update finalized progress.')
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
