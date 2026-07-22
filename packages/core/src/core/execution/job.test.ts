import type { EnabledRule } from '../../dsl/types'
import type { CacheEntry, CacheOwnerTransaction } from '../cache'
import type { FileTarget } from '../source/types'
import type { RuleRuntime, RuleRuntimeState, TargetExecutionPlan } from '../targets/types'
import type { ProgressJob } from '../types'
import type { JobOrderKey, RuleJob } from './types'

import { AsyncLocalStorage } from 'node:async_hooks'

import { expect, it } from 'vitest'

import { defineRule } from '../../dsl/define'
import { compareJobOrder, createRuleJobs, executeRuleJob } from './job'
import { createRuleRuntimes } from './runtime'

it('detaches a completed outcome from the active rule job', async () => {
  const executionState = new AsyncLocalStorage<RuleRuntimeState>()
  const jobRef: ProgressJob = {
    id: 'job-1',
    index: 1,
    inputPath: '/repo/source.ts',
    ruleId: 'company/review',
    ruleIndex: 1,
    ruleTotal: 1,
    target: { identity: 'source.ts', kind: 'file' },
    total: 1,
  }
  const orderKey = {
    inputIndex: 0,
    ruleIndex: 0,
    scope: 'source' as const,
    targetIndex: 0,
  }
  const rule = defineRule({ create: () => ({}) })
  const cacheOwner: CacheOwnerTransaction = {
    commit: () => {},
    discard: () => {},
    lookup: () => undefined,
    put: () => {},
  }
  const job: RuleJob = {
    execution: {
      run: () => {
        const state = executionState.getStore()
        if (!state)
          throw new Error('Expected an active rule runtime state.')
        state.bucket.diagnostics.push({
          filePath: '/repo/source.ts',
          message: 'diagnostic',
          ruleId: 'company/review',
          severity: 'warn',
        })
        state.bucket.usage.push({
          inputTokens: 1,
          modelId: 'model',
          providerId: 'provider',
          ruleId: 'company/review',
        })
      },
      runtime: {
        cacheable: false,
        enabledRule: {
          id: 'company/review',
          localId: 'review',
          options: [],
          rule,
          severity: 'warn' as const,
        },
        executionState,
        handlers: {},
        ruleHash: 'rule-hash',
        ruleIndex: 0,
      },
    },
    jobRef,
    orderKey,
    target: {
      cacheOwner,
      configHash: 'config-hash',
      executions: [],
      identity: 'source.ts',
      kind: 'file' as const,
      language: 'typescript',
      text: 'retained source sentinel',
    },
  }

  const outcome = await executeRuleJob(job, {
    cache: { modelHash: 'model-hash' },
    clock: () => 2,
    startedAt: 1,
  })

  expect(outcome).toEqual({
    cache: 'miss',
    diagnostics: [{
      filePath: '/repo/source.ts',
      message: 'diagnostic',
      ruleId: 'company/review',
      severity: 'warn',
    }],
    jobRef,
    orderKey,
    state: 'completed',
    usage: [{
      inputTokens: 1,
      modelId: 'model',
      providerId: 'provider',
      ruleId: 'company/review',
    }],
  })
  expect(JSON.stringify(outcome)).not.toContain('retained source sentinel')
})

it.each([
  ['throwing message getter', () => Object.defineProperty({}, 'message', { get: () => { throw new Error('hostile getter') } })],
  ['hostile proxy', () => new Proxy({}, { get: () => { throw new Error('hostile proxy') } })],
])('turns a %s into a detached handler failure', async (_name, createCause) => {
  const executionState = new AsyncLocalStorage<RuleRuntimeState>()
  const rule = defineRule({ create: () => ({}) })
  const job = createTestJob({
    executionState,
    rule,
    run: () => {
      throw createCause()
    },
  })

  await expect(executeRuleJob(job, {
    cache: { modelHash: 'model-hash' },
    clock: () => 2,
    startedAt: 1,
  })).resolves.toMatchObject({
    cache: 'miss',
    failure: {
      kind: 'handler',
      message: 'Unknown rule failure.',
    },
    state: 'failed',
  })
})

it.each([
  ['Error', new Error('ordinary failure'), 'ordinary failure'],
  ['string', 'string failure', 'string failure'],
])('preserves an ordinary %s failure message', async (_name, cause, message) => {
  const executionState = new AsyncLocalStorage<RuleRuntimeState>()
  const rule = defineRule({ create: () => ({}) })
  const outcome = await executeRuleJob(createTestJob({
    executionState,
    rule,
    run: () => {
      throw cause
    },
  }), {
    cache: { modelHash: 'model-hash' },
    clock: () => 2,
    startedAt: 1,
  })

  expect(outcome).toMatchObject({ failure: { message }, state: 'failed' })
})

it('isolates the failed outcome from onJobEnd mutations', async () => {
  const executionState = new AsyncLocalStorage<RuleRuntimeState>()
  const rule = defineRule({ create: () => ({}) })
  let endedJob: ProgressJob | undefined
  const outcome = await executeRuleJob(createTestJob({
    executionState,
    rule,
    run: () => {
      throw new Error('original failure')
    },
  }), {
    cache: { modelHash: 'model-hash' },
    clock: () => 2,
    progress: {
      onJobEnd: ({ failure, job }) => {
        endedJob = job
        job.id = 'mutated end id'
        job.target.name = 'mutated end target'
        if (failure) {
          failure.message = 'mutated end failure'
          failure.job.id = 'mutated failure job'
          Object.assign(failure, { backlink: 'attached failure sentinel' })
        }
      },
    },
    startedAt: 1,
  })

  expect(outcome).toMatchObject({
    failure: {
      job: { id: 'job-1', target: { identity: 'source.ts', kind: 'file' } },
      message: 'original failure',
    },
    jobRef: { id: 'job-1', target: { identity: 'source.ts', kind: 'file' } },
    state: 'failed',
  })
  expect(endedJob).not.toBe(outcome.jobRef)
  expect(outcome.state === 'failed' && outcome.failure.job).not.toBe(outcome.jobRef)
  expect(JSON.stringify(outcome)).not.toContain('attached failure sentinel')
})

it('seals terminal records and isolates progress, cache, and outcome snapshots', async () => {
  const evidence = { source: 'public evidence payload' }
  const metadata = { source: 'public usage payload' }
  let releaseLate!: () => void
  const lateGate = new Promise<void>((resolve) => {
    releaseLate = resolve
  })
  let lateFinished!: Promise<void>
  const rule = defineRule({
    create: ctx => ({
      onTargetFile: () => {
        ctx.report({
          evidence,
          loc: { start: { column: 2, line: 1 } },
          message: 'original diagnostic',
        })
        ctx.metering.recordUsage({
          inputTokens: 3,
          metadata,
          modelId: 'model',
          providerId: 'provider',
        })
        lateFinished = lateGate.then(() => {
          ctx.report({ message: 'late diagnostic' })
          ctx.metering.recordUsage({ inputTokens: 100, modelId: 'late', providerId: 'late' })
        })
      },
    }),
  })
  const diagnosticsProgress: string[] = []
  const usageProgress: number[] = []
  const [runtime] = createRuleRuntimes({
    cwd: '/repo',
    effectiveAgent: undefined,
    effectiveSettings: {},
    progress: {
      onDiagnostic: ({ diagnostic }) => {
        diagnosticsProgress.push(diagnostic.message)
        diagnostic.message = 'mutated by reporter'
        if (diagnostic.loc)
          diagnostic.loc.start.line = 99
      },
      onUsage: ({ record }) => {
        usageProgress.push(record.inputTokens ?? 0)
        record.inputTokens = 99
      },
    },
    rules: [{
      enabledRule: {
        id: 'company/review',
        localId: 'review',
        options: [],
        rule,
        severity: 'warn',
      },
      ruleIndex: 0,
    }],
    runOptions: {},
    setupConfig: { providers: [], version: 1 },
    src: {
      getText: target => target.text,
      readFile: () => { throw new Error('unused') },
      sliceLines: () => { throw new Error('unused') },
      sliceRange: () => { throw new Error('unused') },
    },
  })
  if (!runtime)
    throw new Error('Expected a rule runtime.')
  const sourceTarget: FileTarget = {
    file: { language: 'typescript', lines: ['source'], path: '/repo/source.ts', text: 'source' },
    identity: 'source.ts',
    kind: 'file',
    language: 'typescript',
    text: 'source',
  }
  let cachedEntry: CacheEntry | undefined
  const cacheOwner: CacheOwnerTransaction = {
    commit: () => {},
    discard: () => {},
    lookup: () => undefined,
    put: (_slot, entry) => {
      cachedEntry = entry
    },
  }
  const job = createTestJob({
    cacheOwner,
    executionState: runtime.executionState,
    rule,
    run: () => runtime.handlers.onTargetFile?.(sourceTarget),
    runtime,
  })
  job.target.loc = {
    end: { column: 8, line: 2 },
    start: { column: 2, line: 1 },
  }
  job.target.range = { end: 8, start: 2 }
  Object.assign(job.target.loc, { backlink: 'retained target sentinel' })
  Object.assign(job.target.range, { backlink: 'retained target sentinel' })

  const outcome = await executeRuleJob(job, {
    cache: { modelHash: 'model-hash' },
    clock: () => 2,
    startedAt: 1,
  })

  job.target.loc.start.line = 42
  job.target.range.start = 42
  Object.assign(job.target.loc, { after: 'retained target sentinel' })
  Object.assign(job.target.range, { after: 'retained target sentinel' })

  releaseLate()
  await lateFinished

  expect(diagnosticsProgress).toEqual(['original diagnostic'])
  expect(usageProgress).toEqual([3])
  expect(outcome.diagnostics).toEqual([{
    evidence,
    filePath: '/repo/source.ts',
    loc: { start: { column: 2, line: 1 } },
    message: 'original diagnostic',
    model: undefined,
    ruleId: 'company/review',
    severity: 'warn',
  }])
  expect(outcome.usage).toEqual([{
    inputTokens: 3,
    metadata,
    modelId: 'model',
    providerId: 'provider',
    ruleId: 'company/review',
  }])
  expect(cachedEntry?.diagnostics).toEqual(outcome.diagnostics)
  expect(cachedEntry?.usage).toEqual(outcome.usage)
  expect(cachedEntry?.diagnostics).not.toBe(outcome.diagnostics)
  expect(cachedEntry?.diagnostics[0]).not.toBe(outcome.diagnostics[0])
  expect(cachedEntry?.diagnostics[0]?.loc).not.toBe(outcome.diagnostics[0]?.loc)
  expect(cachedEntry?.diagnostics[0]?.loc?.start).not.toBe(outcome.diagnostics[0]?.loc?.start)
  expect(cachedEntry?.usage).not.toBe(outcome.usage)
  expect(cachedEntry?.usage[0]).not.toBe(outcome.usage[0])
  expect(outcome.diagnostics[0]?.evidence).toBe(evidence)
  expect(outcome.usage[0]?.metadata).toBe(metadata)

  outcome.diagnostics[0]!.message = 'mutated outcome'
  outcome.diagnostics[0]!.loc!.start.line = 42
  outcome.usage[0]!.inputTokens = 42
  expect(cachedEntry?.diagnostics[0]?.message).toBe('original diagnostic')
  expect(cachedEntry?.diagnostics[0]?.loc?.start.line).toBe(1)
  expect(cachedEntry?.usage[0]?.inputTokens).toBe(3)
  expect(cachedEntry?.target).toEqual({
    hash: expect.any(String),
    identity: 'source.ts',
    kind: 'file',
    loc: {
      end: { column: 8, line: 2 },
      start: { column: 2, line: 1 },
    },
    name: undefined,
    range: { end: 8, start: 2 },
  })
  expect(JSON.stringify(cachedEntry?.target)).not.toContain('retained target sentinel')
})

it('compares job order by scope, input, target, then prepared rule index', () => {
  const keys: JobOrderKey[] = [
    { inputIndex: 0, ruleIndex: 0, scope: 'project', targetIndex: 0 },
    { inputIndex: 0, ruleIndex: 2, scope: 'source', targetIndex: 0 },
    { inputIndex: 0, ruleIndex: 1, scope: 'directory', targetIndex: 0 },
    { inputIndex: 1, ruleIndex: 0, scope: 'source', targetIndex: 0 },
    { inputIndex: 0, ruleIndex: 0, scope: 'source', targetIndex: 1 },
    { inputIndex: 0, ruleIndex: 1, scope: 'source', targetIndex: 0 },
  ]

  expect(keys.toSorted(compareJobOrder)).toEqual([
    { inputIndex: 0, ruleIndex: 1, scope: 'source', targetIndex: 0 },
    { inputIndex: 0, ruleIndex: 2, scope: 'source', targetIndex: 0 },
    { inputIndex: 0, ruleIndex: 0, scope: 'source', targetIndex: 1 },
    { inputIndex: 1, ruleIndex: 0, scope: 'source', targetIndex: 0 },
    { inputIndex: 0, ruleIndex: 1, scope: 'directory', targetIndex: 0 },
    { inputIndex: 0, ruleIndex: 0, scope: 'project', targetIndex: 0 },
  ])
})

it('counts zero-job plans in the scope-local input index', () => {
  const rule = defineRule({ create: () => ({}) })
  const runtime: RuleRuntime = {
    cacheable: false,
    enabledRule: {
      id: 'company/review',
      localId: 'review',
      options: [],
      rule,
      severity: 'warn',
    },
    executionState: new AsyncLocalStorage<RuleRuntimeState>(),
    handlers: {},
    ruleHash: 'rule-hash',
    ruleIndex: 3,
  }
  const plans: TargetExecutionPlan[] = [
    {
      id: 'source:empty.ts',
      index: 1,
      kind: 'source',
      path: '/repo/empty.ts',
      planned: 0,
      targets: [],
    },
    {
      id: 'source:review.ts',
      index: 2,
      kind: 'source',
      path: '/repo/review.ts',
      planned: 1,
      targets: [{
        configHash: 'config-hash',
        executions: [{ run: () => {}, runtime }],
        identity: 'review.ts',
        kind: 'file',
        language: 'typescript',
        text: 'source',
      }],
    },
  ]

  expect(createRuleJobs(plans)[0]?.orderKey).toEqual({
    inputIndex: 1,
    ruleIndex: 3,
    scope: 'source',
    targetIndex: 0,
  })
})

function createTestJob(options: {
  cacheOwner?: CacheOwnerTransaction
  executionState: AsyncLocalStorage<RuleRuntimeState>
  rule: EnabledRule['rule']
  run: () => Promise<void> | void
  runtime?: RuleRuntime
}): RuleJob {
  const runtime: RuleRuntime = options.runtime ?? {
    cacheable: false,
    enabledRule: {
      id: 'company/review',
      localId: 'review',
      options: [],
      rule: options.rule,
      severity: 'warn',
    },
    executionState: options.executionState,
    handlers: {},
    ruleHash: 'rule-hash',
    ruleIndex: 0,
  }
  return {
    execution: { run: options.run, runtime },
    jobRef: {
      id: 'job-1',
      index: 1,
      inputPath: '/repo/source.ts',
      ruleId: 'company/review',
      ruleIndex: 1,
      ruleTotal: 1,
      target: { identity: 'source.ts', kind: 'file' },
      total: 1,
    },
    orderKey: { inputIndex: 0, ruleIndex: 0, scope: 'source', targetIndex: 0 },
    target: {
      activeFilePath: '/repo/source.ts',
      cacheOwner: options.cacheOwner,
      configHash: 'config-hash',
      executions: [],
      identity: 'source.ts',
      kind: 'file',
      language: 'typescript',
      text: 'source',
    },
  }
}
