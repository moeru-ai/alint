import type { ExecutionTarget, RuleRuntime, TargetExecutionPlan } from '../targets/types'
import type { Diagnostic, InferenceUsageRecord } from '../types'

import { AsyncLocalStorage } from 'node:async_hooks'

import { describe, expect, it } from 'vitest'

import { createRuleExecutionJobs } from './jobs'
import { createExecutionProjection } from './projection'

describe('execution projection', () => {
  it('projects diagnostics and usage in planned job order while preserving bucket order', () => {
    const jobs = createRuleExecutionJobs(createFixture([{ targets: [['first', 'second']] }]))
    const projection = createExecutionProjection()
    const secondObservation = projection.register(jobs[1]!)
    const second = secondObservation.bucket
    const firstObservation = projection.register(jobs[0]!)
    const first = firstObservation.bucket

    second.diagnostics.push(diagnostic('second:1'), diagnostic('second:2'))
    second.usage.push(usage('second', 20))
    secondObservation.markCached()
    first.diagnostics.push(diagnostic('first:1'), diagnostic('first:2'))
    first.usage.push(usage('first', 10))

    expect(projection.diagnostics()).toEqual([
      diagnostic('first:1'),
      diagnostic('first:2'),
      diagnostic('second:1'),
      diagnostic('second:2'),
    ])
    expect(projection.usage()).toEqual({
      cached: {
        inputTokens: 20,
        outputTokens: 20,
        records: [usage('second', 20)],
        totalTokens: 20,
      },
      inputTokens: 10,
      outputTokens: 10,
      records: [usage('first', 10)],
      totalTokens: 10,
    })
  })

  it('rejects duplicate registration', () => {
    const job = createRuleExecutionJobs(createFixture([{ targets: [['first']] }]))[0]!
    const projection = createExecutionProjection()
    projection.register(job)
    expect(() => projection.register(job)).toThrow('more than once')
  })

  it('returns an owned usage records array without losing record metadata', () => {
    const job = createRuleExecutionJobs(createFixture([{ targets: [['first']] }]))[0]!
    const projection = createExecutionProjection()
    const observation = projection.register(job)
    const record = { ...usage('first', 7), metadata: { request: 'original' } }
    observation.bucket.usage.push(record)

    const first = projection.usage()
    first.records.push(usage('mutation', 99))

    expect(projection.usage()).toEqual({
      inputTokens: 7,
      outputTokens: 7,
      records: [record],
      totalTokens: 7,
    })
  })
})

function createFixture(specs: Array<{ targets: string[][] }>): TargetExecutionPlan[] {
  return specs.map((spec, planIndex) => ({
    id: `plan:${planIndex}`,
    index: planIndex + 1,
    kind: 'source',
    path: `/repo/${planIndex}.ts`,
    planned: spec.targets.reduce((total, ids) => total + ids.length, 0),
    targets: spec.targets.map((ids, targetIndex): ExecutionTarget => ({
      cacheFilePaths: [],
      configHash: '',
      executions: ids.map(id => ({ run: () => {}, runtime: runtime(id) })),
      identity: `target:${targetIndex}`,
      kind: 'file',
      language: 'text',
      text: '',
    })),
  }))
}

function diagnostic(message: string): Diagnostic {
  return { filePath: '/repo/a.ts', message, ruleId: message, severity: 'warn' }
}

function runtime(id: string): RuleRuntime {
  return {
    cacheable: true,
    enabledRule: { id, localId: id, rule: { create: () => ({}) }, severity: 'warn' },
    executionState: new AsyncLocalStorage(),
    handlers: {},
    ruleHash: id,
  }
}

function usage(ruleId: string, tokens: number): InferenceUsageRecord {
  return {
    inputTokens: tokens,
    modelId: 'model',
    outputTokens: tokens,
    providerId: 'provider',
    ruleId,
    totalTokens: tokens,
  }
}
