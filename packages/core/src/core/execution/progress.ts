import type { ExecutionCounts, ProgressSnapshot } from '../types'

export interface IndexedAdmissionJob<T> {
  index: number
  job: T
}

export interface JobAdmissionGroups<T> {
  nonSource: Array<IndexedAdmissionJob<T>>
  sourceByInput: Array<Array<IndexedAdmissionJob<T>> | undefined>
}

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

export function groupJobsForAdmission<T extends { orderKey: { inputIndex: number, scope: 'directory' | 'project' | 'source' } }>(
  jobs: readonly T[],
): JobAdmissionGroups<T> {
  const nonSource: Array<IndexedAdmissionJob<T>> = []
  const sourceByInput: Array<Array<IndexedAdmissionJob<T>> | undefined> = []

  for (const [index, job] of jobs.entries()) {
    const indexed = { index, job }
    if (job.orderKey.scope === 'source') {
      const bucket = sourceByInput[job.orderKey.inputIndex] ?? []
      bucket.push(indexed)
      sourceByInput[job.orderKey.inputIndex] = bucket
    }
    else {
      nonSource.push(indexed)
    }
  }

  return { nonSource, sourceByInput }
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
