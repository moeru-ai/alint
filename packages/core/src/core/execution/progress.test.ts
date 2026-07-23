import type { ExecutionCounts } from '../types'

import { describe, expect, it } from 'vitest'

import { createRunProgress } from './progress'

function counts(overrides: Partial<ExecutionCounts> = {}): ExecutionCounts {
  return {
    cached: 0,
    cancelled: 0,
    completed: 0,
    failed: 0,
    planned: 0,
    queued: 0,
    running: 0,
    skipped: 0,
    ...overrides,
  }
}

describe('createRunProgress', () => {
  it.each([0, 2, 7])('starts with %i files and no admitted jobs', (filesTotal) => {
    expect(createRunProgress(filesTotal).snapshot()).toEqual({
      execution: counts(),
      filesTotal,
      final: false,
      jobsCompleted: 0,
      jobsStarted: 0,
      jobsTotal: 0,
    })
  })

  it('tracks admitted, running, and every terminal job state', () => {
    const progress = createRunProgress(2)
    progress.queue(7)
    progress.start()
    progress.finish('running', 'completed')
    progress.start()
    progress.finish('running', 'cached')
    progress.start()
    progress.finish('running', 'failed')
    progress.start()
    progress.finish('running', 'skipped')
    progress.start()
    progress.finish('running', 'cancelled')
    progress.finish('queued', 'cancelled')
    progress.finish('queued', 'cancelled')

    expect(progress.snapshot()).toEqual({
      execution: counts({ cached: 1, cancelled: 3, completed: 1, failed: 1, planned: 7, skipped: 1 }),
      filesTotal: 2,
      final: false,
      jobsCompleted: 7,
      jobsStarted: 7,
      jobsTotal: 7,
    })
  })

  it('returns detached snapshots', () => {
    const progress = createRunProgress(1)
    const snapshot = progress.snapshot()
    snapshot.execution.planned = 99

    expect(progress.snapshot().execution.planned).toBe(0)
  })

  it('finalizes only after all admitted jobs are terminal', () => {
    const progress = createRunProgress(1)
    progress.queue(1)
    expect(() => progress.finalize()).toThrow('queued or running')
    progress.finish('queued', 'cancelled')

    expect(progress.finalize()).toMatchObject({ final: true, jobsCompleted: 1, jobsStarted: 1, jobsTotal: 1 })
    expect(progress.snapshot().final).toBe(true)
    expect(() => progress.queue(1)).toThrow('finalized')
  })

  it('rejects invalid counts and transitions', () => {
    expect(() => createRunProgress(-1)).toThrow(TypeError)
    expect(() => createRunProgress(1.5)).toThrow(TypeError)

    const progress = createRunProgress(1)
    expect(() => progress.queue(-1)).toThrow(TypeError)
    expect(() => progress.queue(1.5)).toThrow(TypeError)
    expect(() => progress.start()).toThrow('queued')
    expect(() => progress.finish('queued', 'completed')).toThrow('queued')
    progress.queue(1)
    expect(() => progress.finish('running', 'completed')).toThrow('running')
  })

  it('rejects cumulative queue overflow without changing state', () => {
    const progress = createRunProgress(0)
    progress.queue(Number.MAX_SAFE_INTEGER)

    expect(() => progress.queue()).toThrow(TypeError)
    expect(progress.snapshot()).toMatchObject({
      execution: { planned: Number.MAX_SAFE_INTEGER, queued: Number.MAX_SAFE_INTEGER },
      jobsTotal: Number.MAX_SAFE_INTEGER,
    })
  })
})
