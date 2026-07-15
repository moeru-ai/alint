import type { ExecutionTarget, RuleRuntime, RuleTargetExecution, TargetExecutionPlan } from '../targets/types'
import type { ExecutionCounts, ProgressReporter } from '../types'
import type { RuleExecutionJob, RuleExecutionOutcome } from './types'

import { AsyncLocalStorage } from 'node:async_hooks'

import { describe, expect, it, vi } from 'vitest'

import { createRuleExecutionJobs } from './jobs'
import { RunProgress } from './progress'

describe('runProgress', () => {
  it('isolates a reporter fault while lifecycle state keeps advancing', () => {
    const reporterError = new Error('reporter failed')
    const onPlanStart = vi.fn()
    const jobs = createRuleExecutionJobs(fixture([['a']]))
    const progress = new RunProgress({
      onPlanStart,
      onRuleStart: () => { throw reporterError },
    }, jobs)

    progress.emit('onRuleStart', { path: jobs[0]!.path, startedAt: 1 })
    progress.startJob(jobs[0]!)
    progress.endJob(outcome(jobs[0]!, 'completed'))

    expect(progress.error).toBe(reporterError)
    expect(onPlanStart).not.toHaveBeenCalled()
    expect(progress.execution).toEqual(counts({ completed: 1, planned: 1 }))
  })

  it('normalizes a nullish reporter failure', () => {
    const jobs = createRuleExecutionJobs(fixture([['a']]))
    const progress = new RunProgress({
      // eslint-disable-next-line no-throw-literal -- Verifies normalization at an external callback boundary.
      onRuleStart: () => { throw null },
    }, jobs)

    progress.emit('onRuleStart', { path: jobs[0]!.path })

    expect(progress.error).toEqual(new Error('Unknown progress reporter error.'))
  })

  it('emits one parent lifecycle around overlapping children', () => {
    const events: string[] = []
    const jobs = createRuleExecutionJobs(fixture([['a', 'b']]))
    const progress = new RunProgress({
      onPlanEnd: () => events.push('plan:end'),
      onPlanStart: () => events.push('plan:start'),
      onTargetEnd: () => events.push('target:end'),
      onTargetStart: () => events.push('target:start'),
    }, jobs)

    progress.startJob(jobs[0]!)
    progress.startJob(jobs[1]!)
    progress.endJob(outcome(jobs[1]!, 'cached'))
    progress.endJob(outcome(jobs[0]!, 'completed'))

    expect(events).toEqual(['plan:start', 'target:start', 'target:end', 'plan:end'])
  })

  it('keeps terminal states exclusive after every transition', () => {
    const jobs = createRuleExecutionJobs(fixture([['a', 'b', 'c', 'd']]))
    const progress = new RunProgress(undefined, jobs)
    const states: RuleExecutionOutcome['state'][] = ['cached', 'completed', 'failed', 'cancelled']

    for (const [index, job] of jobs.entries()) {
      progress.startJob(job)
      progress.endJob(outcome(job, states[index]!))
      assertInvariant(progress.execution)
    }
    expect(progress.execution).toEqual(counts({ cached: 1, cancelled: 1, completed: 1, failed: 1, planned: 4 }))
  })

  it('cancels queued jobs without starting lifecycle events', () => {
    const reporter: ProgressReporter = {
      onPlanStart: vi.fn(),
      onTargetStart: vi.fn(),
    }
    const jobs = createRuleExecutionJobs(fixture([['a', 'b']]))
    const progress = new RunProgress(reporter, jobs)

    progress.cancelQueuedJobs()

    expect(reporter.onPlanStart).not.toHaveBeenCalled()
    expect(reporter.onTargetStart).not.toHaveBeenCalled()
    expect(progress.execution).toEqual(counts({ cancelled: 2, planned: 2 }))
  })

  it('moves an interrupted running job to cancelled', () => {
    const jobs = createRuleExecutionJobs(fixture([['a']]))
    const progress = new RunProgress(undefined, jobs)

    progress.startJob(jobs[0]!)
    progress.interruptJob(jobs[0]!)

    expect(progress.execution).toEqual(counts({ cancelled: 1, planned: 1 }))
  })

  it('protects counters from reporter and getter mutation', () => {
    const jobs = createRuleExecutionJobs(fixture([['a']]))
    const progress = new RunProgress({
      onPlanStart: (payload) => {
        payload.execution.completed = 100
        payload.execution.running = 0
      },
    }, jobs)

    progress.startJob(jobs[0]!)
    progress.execution.failed = 100
    progress.endJob(outcome(jobs[0]!, 'completed'))

    expect(progress.execution).toEqual(counts({ completed: 1, planned: 1 }))
  })
})

function assertInvariant(execution: ExecutionCounts): void {
  expect(execution.queued + execution.running + execution.cached + execution.completed + execution.failed + execution.cancelled + execution.skipped)
    .toBe(execution.planned)
}

function counts(overrides: Partial<ExecutionCounts>): ExecutionCounts {
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

function fakeExecution(ruleId: string): RuleTargetExecution {
  const runtime: RuleRuntime = {
    cacheable: false,
    enabledRule: {
      id: ruleId,
      localId: ruleId,
      rule: { create: () => ({ onTargetWith: () => {} }) },
      severity: 'error',
    },
    executionState: new AsyncLocalStorage(),
    handlers: { onTargetWith: () => {} },
    ruleHash: `hash:${ruleId}`,
  }
  return { run: () => {}, runtime }
}

function fixture(ruleIds: string[][]): TargetExecutionPlan[] {
  const targets = ruleIds.map((ids, targetIndex): ExecutionTarget => ({
    cacheFilePaths: [],
    configHash: `config:${targetIndex}`,
    executions: ids.map(fakeExecution),
    identity: `target:${targetIndex}`,
    kind: 'file',
    language: 'text',
    text: '',
  }))
  return [{ id: 'plan', index: 1, kind: 'source', path: '/repo/a.ts', planned: targets.flatMap(target => target.executions).length, targets }]
}

function outcome(job: RuleExecutionJob, state: RuleExecutionOutcome['state']): RuleExecutionOutcome {
  if (state === 'failed') {
    return {
      bucket: { diagnostics: [], usage: [] },
      cache: 'miss',
      cause: new Error('failed'),
      failure: { kind: 'handler', message: 'failed', path: job.path },
      job,
      state,
    }
  }
  if (state === 'cached') {
    return {
      bucket: { diagnostics: [], usage: [] },
      cache: 'hit',
      job,
      state,
    }
  }
  return {
    bucket: { diagnostics: [], usage: [] },
    cache: 'miss',
    job,
    state,
  }
}
