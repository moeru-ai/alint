import type { ExecutionTarget, RuleRuntime, RuleTargetExecution, TargetExecutionPlan } from '../targets/types'

import { AsyncLocalStorage } from 'node:async_hooks'

import { describe, expect, it, vi } from 'vitest'

import { createRuleExecutionJobs } from './jobs'

describe('createRuleExecutionJobs', () => {
  it('materializes lazy jobs in stable plan, target, and rule order', () => {
    const runs = [vi.fn(), vi.fn(), vi.fn(), vi.fn()]
    const source = plan('source', [
      target('file', [execution('a', runs[0]!), execution('b', runs[1]!)]),
      target('function', [execution('c', runs[2]!)]),
    ], 1)
    const project = plan('project', [target('project', [execution('d', runs[3]!)])], 2)

    const jobs = createRuleExecutionJobs([source, project])

    expect(jobs.map(job => [
      job.path.job.index,
      job.path.plan.kind,
      job.path.target.kind,
      job.path.rule.id,
    ])).toEqual([
      [1, 'source', 'file', 'a'],
      [2, 'source', 'file', 'b'],
      [3, 'source', 'function', 'c'],
      [4, 'project', 'project', 'd'],
    ])
    expect(runs.every(run => !run.mock.calls.length)).toBe(true)
  })
})

function execution(id: string, run: () => void): RuleTargetExecution {
  const runtime: RuleRuntime = {
    cacheable: false,
    enabledRule: {
      id,
      localId: id,
      rule: { create: () => ({ onTargetWith: () => {} }) },
      severity: 'error',
    },
    executionState: new AsyncLocalStorage(),
    handlers: { onTargetWith: () => {} },
    ruleHash: id,
  }
  return { run, runtime }
}

function plan(kind: TargetExecutionPlan['kind'], targets: ExecutionTarget[], index: number): TargetExecutionPlan {
  return {
    id: kind,
    index,
    kind,
    path: `/repo/${kind}`,
    planned: targets.reduce((total, item) => total + item.executions.length, 0),
    targets,
  }
}

function target(kind: ExecutionTarget['kind'], executions: RuleTargetExecution[]): ExecutionTarget {
  return {
    cacheFilePaths: [],
    configHash: kind,
    executions,
    identity: kind,
    kind,
    language: kind,
    text: '',
  }
}
