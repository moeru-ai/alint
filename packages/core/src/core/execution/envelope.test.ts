import type { CacheEntry, CacheStore } from '../cache'
import type { ExecutionTarget, RuleExecutionBucket, RuleRuntime, RuleRuntimeState, TargetExecutionPlan } from '../targets/types'
import type { Diagnostic, InferenceUsageRecord, ProgressReporter } from '../types'
import type { RuleExecutionJob, RuleExecutionOutcome } from './types'

import { AsyncLocalStorage } from 'node:async_hooks'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { executeRuleExecutionJob } from './envelope'
import { RunProgress } from './progress'
import { createExecutionProjection } from './projection'

describe('executeRuleExecutionJob', () => {
  afterEach(() => vi.useRealTimers())

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid timeout %s before starting the rule',
    async (timeoutMs) => {
      const handler = vi.fn()
      const onRuleStart = vi.fn()
      const fixture = createFixture(handler, { reporter: { onRuleStart } })

      await expect(executeRuleExecutionJob(fixture.job, {
        ...fixture.options,
        timeoutMs,
      })).rejects.toThrow(new TypeError('Rule execution timeout must be a finite positive integer.'))
      expect(onRuleStart).not.toHaveBeenCalled()
      expect(handler).not.toHaveBeenCalled()
    },
  )

  it('records a successful live execution in its job bucket before writing cache', async () => {
    const events: string[] = []
    const diagnostic = fakeDiagnostic('first')
    const usage = fakeUsage('model')
    const fixture = createFixture(async (state) => {
      state.bucket.diagnostics.push(diagnostic)
      state.bucket.usage.push(usage)
      events.push('handler')
    }, {
      cacheable: true,
      cacheFilePaths: ['/repo/source.ts'],
      onSet: (_key, entry) => {
        events.push('cache:set')
        expect(entry.diagnostics).toEqual([diagnostic])
        expect(entry.usage).toEqual([usage])
      },
    })

    const outcome = await executeRuleExecutionJob(fixture.job, fixture.options)

    expect(outcome.state).toBe('completed')
    expect(outcome.cache).toBe('miss')
    expect(outcome.failure).toBeUndefined()
    expect(outcome.bucket).toEqual({ diagnostics: [diagnostic], usage: [usage] })
    expect(events).toEqual(['handler', 'cache:set'])
    expect(fixture.store.set).toHaveBeenCalledOnce()
  })

  it('replays a cache hit into the bucket and skips the live handler and cache write', async () => {
    const handler = vi.fn()
    const diagnostic = fakeDiagnostic('cached')
    const usage = fakeUsage('cached-model')
    const ruleEvents: string[] = []
    const fixture = createFixture(handler, {
      cacheable: true,
      cacheEntry: fakeCacheEntry([diagnostic], [usage]),
      cacheFilePaths: ['/repo/source.ts'],
      reporter: {
        onRuleEnd: payload => ruleEvents.push(`end:${payload.state}:${payload.cache}`),
        onRuleStart: () => ruleEvents.push('start'),
      },
    })

    const outcome = await executeRuleExecutionJob(fixture.job, fixture.options)

    expect(outcome.state).toBe('cached')
    expect(outcome.cache).toBe('hit')
    expect(outcome.bucket.diagnostics).toEqual([{ ...diagnostic, cached: true }])
    expect(outcome.bucket.usage).toEqual([usage])
    expect(handler).not.toHaveBeenCalled()
    expect(fixture.store.set).not.toHaveBeenCalled()
    expect(ruleEvents).toEqual(['start', 'end:cached:hit'])
  })

  it('returns a handler failure with the original cause and does not write cache', async () => {
    const cause = new Error('handler exploded')
    const fixture = createFixture(() => {
      throw cause
    }, {
      cacheable: true,
      cacheFilePaths: ['/repo/source.ts'],
    })

    const outcome = await executeRuleExecutionJob(fixture.job, fixture.options)

    expect(outcome).toMatchObject({
      cache: 'miss',
      cause,
      failure: { kind: 'handler', message: 'handler exploded', path: fixture.job.path },
      state: 'failed',
    })
    expect(fixture.store.set).not.toHaveBeenCalled()
  })

  it('does not fall back to the handler when cache replay fails', async () => {
    const cause = new Error('bad cache payload')
    const entry = fakeCacheEntry([], [])
    Object.defineProperty(entry, 'diagnostics', {
      get: () => {
        throw cause
      },
    })
    const handler = vi.fn()
    const fixture = createFixture(handler, {
      cacheable: true,
      cacheEntry: entry,
      cacheFilePaths: ['/repo/source.ts'],
    })

    const outcome = await executeRuleExecutionJob(fixture.job, fixture.options)

    expect(outcome).toMatchObject({
      cache: 'hit',
      cause,
      failure: { kind: 'cache-replay', message: 'bad cache payload', path: fixture.job.path },
      state: 'failed',
    })
    expect(handler).not.toHaveBeenCalled()
    expect(fixture.store.set).not.toHaveBeenCalled()
  })

  it('aborts at the deadline but waits for the actual handler promise to settle', async () => {
    vi.useFakeTimers()
    const deferred = createDeferred<void>()
    let observedSignal: AbortSignal | undefined
    const fixture = createFixture(async (state) => {
      observedSignal = state.signal
      await deferred.promise
    }, {
      cacheable: true,
      cacheFilePaths: ['/repo/source.ts'],
    })
    const execution = executeRuleExecutionJob(fixture.job, { ...fixture.options, timeoutMs: 25 })
    const settled = vi.fn()
    void execution.then(settled)

    await vi.advanceTimersByTimeAsync(25)

    expect(observedSignal?.aborted).toBe(true)
    expect(observedSignal?.reason).toEqual(new Error('Rule execution timed out after 25ms.'))
    expect(settled).not.toHaveBeenCalled()

    deferred.resolve()
    const outcome = await execution

    expect(outcome.state).toBe('failed')
    expect(outcome.failure?.kind).toBe('timeout')
    expect(outcome.cause).toBe(observedSignal?.reason)
    expect(fixture.store.set).not.toHaveBeenCalled()
  })

  it('forwards the exact run cancellation reason and waits for handler settlement', async () => {
    const controller = new AbortController()
    const reason = { source: 'caller' }
    const deferred = createDeferred<void>()
    let observedSignal: AbortSignal | undefined
    const fixture = createFixture(async (state) => {
      observedSignal = state.signal
      await deferred.promise
    })
    const execution = executeRuleExecutionJob(fixture.job, { ...fixture.options, runSignal: controller.signal })
    const settled = vi.fn()
    void execution.then(settled)

    controller.abort(reason)
    await Promise.resolve()

    expect(observedSignal?.reason).toBe(reason)
    expect(settled).not.toHaveBeenCalled()
    deferred.resolve()

    const outcome = await execution
    expect(outcome).toMatchObject({ cache: 'miss', state: 'cancelled' })
    expect(outcome.failure).toBeUndefined()
    expect(fixture.store.set).not.toHaveBeenCalled()
  })

  it('keeps successful execution completed when the opportunistic cache set throws', async () => {
    const fixture = createFixture(() => {}, {
      cacheable: true,
      cacheFilePaths: ['/repo/source.ts'],
      onSet: () => { throw new Error('disk unavailable') },
    })

    expect((await executeRuleExecutionJob(fixture.job, fixture.options)).state).toBe('completed')
  })

  it('stores an owned snapshot of successful bucket records', async () => {
    const evidence = { retained: true }
    const diagnostic: Diagnostic = {
      evidence,
      filePath: '/repo/source.ts',
      loc: { end: { column: 4, line: 2 }, start: { column: 1, line: 2 } },
      message: 'original',
      model: { providerId: 'local', resolvedId: 'model' },
      ruleId: 'plugin/rule',
      severity: 'warn',
    }
    const usage = { ...fakeUsage('model'), inputTokens: 3 }
    let cachedEntry: CacheEntry | undefined
    const fixture = createFixture((state) => {
      state.bucket.diagnostics.push(diagnostic)
      state.bucket.usage.push(usage)
    }, {
      cacheable: true,
      cacheFilePaths: ['/repo/source.ts'],
      onSet: (_key, entry) => cachedEntry = entry,
    })

    const outcome = await executeRuleExecutionJob(fixture.job, fixture.options)
    outcome.bucket.diagnostics.push(fakeDiagnostic('later'))
    outcome.bucket.usage.push(fakeUsage('later'))
    outcome.bucket.diagnostics[0]!.message = 'mutated'
    outcome.bucket.diagnostics[0]!.loc!.start.line = 99
    outcome.bucket.diagnostics[0]!.model!.resolvedId = 'mutated'
    outcome.bucket.usage[0]!.inputTokens = 99

    expect(cachedEntry?.diagnostics).toEqual([diagnosticSnapshot(evidence)])
    expect(cachedEntry?.diagnostics[0]?.evidence).toBe(evidence)
    expect(cachedEntry?.usage).toEqual([{ ...fakeUsage('model'), inputTokens: 3 }])
  })

  it('gives run cancellation precedence when the deadline and run abort both occur', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const deferred = createDeferred<void>()
    const fixture = createFixture(async () => deferred.promise)
    const execution = executeRuleExecutionJob(fixture.job, {
      ...fixture.options,
      runSignal: controller.signal,
      timeoutMs: 5,
    })

    await vi.advanceTimersByTimeAsync(5)
    controller.abort(new Error('cancelled after deadline'))
    deferred.resolve()

    expect((await execution).state).toBe('cancelled')
  })

  it('cancels a started pre-aborted job before cache lookup or handler execution', async () => {
    const controller = new AbortController()
    const reason = new Error('already cancelled')
    controller.abort(reason)
    const handler = vi.fn()
    const fixture = createFixture(handler, {
      cacheable: true,
      cacheEntry: fakeCacheEntry([fakeDiagnostic('cached')], [fakeUsage('cached')]),
      cacheFilePaths: ['/repo/source.ts'],
    })

    const outcome = await executeRuleExecutionJob(fixture.job, {
      ...fixture.options,
      runSignal: controller.signal,
    })

    expect(outcome).toMatchObject({ bucket: { diagnostics: [], usage: [] }, cache: 'miss', state: 'cancelled' })
    expect(handler).not.toHaveBeenCalled()
    expect(fixture.store.get).not.toHaveBeenCalled()
  })

  it('removes cancellation and timeout effects after settlement', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    let scopedSignal: AbortSignal | undefined
    const fixture = createFixture((state) => {
      scopedSignal = state.signal
    })

    const outcome = await executeRuleExecutionJob(fixture.job, {
      ...fixture.options,
      runSignal: controller.signal,
      timeoutMs: 10,
    })
    controller.abort(new Error('late cancellation'))
    await vi.advanceTimersByTimeAsync(10)

    expect(outcome.state).toBe('completed')
    expect(scopedSignal?.aborted).toBe(false)
  })

  it('rejects a cache lookup throw as infrastructure without invoking the handler', async () => {
    const handler = vi.fn()
    const cause = new Error('cache store unavailable')
    const fixture = createFixture(handler, {
      cacheable: true,
      cacheFilePaths: ['/repo/source.ts'],
      onGet: () => { throw cause },
    })

    await expect(executeRuleExecutionJob(fixture.job, fixture.options)).rejects.toBe(cause)
    expect(handler).not.toHaveBeenCalled()
    expect(fixture.store.set).not.toHaveBeenCalled()
  })

  it('emits exactly one start and end with the same path and envelope timing', async () => {
    const events: unknown[] = []
    const times = [20, 35]
    const fixture = createFixture(() => {}, {
      clock: () => times.shift()!,
      reporter: {
        onRuleEnd: payload => events.push(['end', payload]),
        onRuleStart: payload => events.push(['start', payload]),
      },
    })

    await executeRuleExecutionJob(fixture.job, fixture.options)

    expect(events).toEqual([
      ['start', { path: fixture.job.path, startedAt: 20 }],
      ['end', {
        cache: 'miss',
        endedAt: 35,
        failure: undefined,
        path: fixture.job.path,
        startedAt: 20,
        state: 'completed',
      }],
    ])
  })
})

function assertRuleExecutionOutcomeTypes(job: RuleExecutionJob, bucket: RuleExecutionBucket): void {
  // @ts-expect-error Failed outcomes require both failure and cause properties.
  const failedWithoutFailure: RuleExecutionOutcome = { bucket, cache: 'miss', job, state: 'failed' }
  const successfulWithFailure: RuleExecutionOutcome = {
    bucket,
    cache: 'miss',
    // @ts-expect-error Successful outcomes cannot carry a rule failure.
    failure: { kind: 'handler', message: 'invalid', path: job.path },
    job,
    state: 'completed',
  }
  void failedWithoutFailure
  void successfulWithFailure
}

void assertRuleExecutionOutcomeTypes

function createDeferred<T>() {
  let resolve!: (value: PromiseLike<T> | T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function createFixture(
  handler: (state: RuleRuntimeState) => Promise<void> | void,
  options: {
    cacheable?: boolean
    cacheEntry?: CacheEntry
    cacheFilePaths?: string[]
    clock?: () => number
    onGet?: (key: string) => CacheEntry | undefined
    onSet?: (key: string, entry: CacheEntry) => void
    reporter?: ProgressReporter
  } = {},
) {
  const executionState = new AsyncLocalStorage<RuleRuntimeState>()
  const runtime: RuleRuntime = {
    cacheable: options.cacheable ?? false,
    enabledRule: {
      id: 'plugin/rule',
      localId: 'rule',
      rule: { create: () => ({}) },
      severity: 'warn',
    },
    executionState,
    handlers: {},
    ruleHash: 'rule-hash',
  }
  const target: ExecutionTarget = {
    activeFilePath: '/repo/source.ts',
    cacheFilePaths: options.cacheFilePaths ?? [],
    configHash: 'config-hash',
    executions: [],
    identity: 'file',
    kind: 'file',
    language: 'typescript',
    text: 'source',
  }
  const plan: TargetExecutionPlan = {
    id: 'source:/repo/source.ts',
    index: 1,
    kind: 'source',
    path: '/repo/source.ts',
    planned: 1,
    targets: [target],
  }
  const job: RuleExecutionJob = {
    execution: {
      run: () => handler(expectRuntimeState(executionState)),
      runtime,
    },
    path: {
      job: { index: 1, total: 1 },
      plan: { ...plan, total: 1 },
      rule: { id: 'plugin/rule', index: 1, total: 1 },
      target: { identity: 'file', index: 1, kind: 'file', total: 1 },
    },
    plan,
    target,
  }
  target.executions.push(job.execution)

  const store: CacheStore = {
    get: vi.fn(key => options.onGet ? options.onGet(key) : options.cacheEntry),
    location: '/repo/.alintcache',
    markFile: vi.fn(),
    reconcile: vi.fn(async () => {}),
    set: vi.fn((key, entry) => options.onSet?.(key, entry)),
  }
  const clock = options.clock ?? (() => 10)
  const progress = new RunProgress(options.reporter, [job], clock)
  const projection = createExecutionProjection()

  return {
    job,
    options: {
      cache: {
        cwd: '/repo',
        enabled: true,
        fileEntryKeys: new Map<string, Set<string>>(),
        modelHash: 'model-hash',
        store,
      },
      clock,
      observation: projection.register(job),
      progress,
    },
    progress,
    store,
  }
}

function diagnosticSnapshot(evidence: unknown): Diagnostic {
  return {
    evidence,
    filePath: '/repo/source.ts',
    loc: { end: { column: 4, line: 2 }, start: { column: 1, line: 2 } },
    message: 'original',
    model: { providerId: 'local', resolvedId: 'model' },
    ruleId: 'plugin/rule',
    severity: 'warn',
  }
}

function expectRuntimeState(storage: AsyncLocalStorage<RuleRuntimeState>): RuleRuntimeState {
  const state = storage.getStore()
  if (!state)
    throw new Error('missing execution state')
  return state
}

function fakeCacheEntry(diagnostics: Diagnostic[], usage: InferenceUsageRecord[]): CacheEntry {
  return {
    diagnostics,
    filePath: 'source.ts',
    fingerprint: {
      alintVersion: '0.0.25',
      configHash: 'config-hash',
      modelHash: 'model-hash',
      ruleHash: 'rule-hash',
    },
    target: { hash: 'target-hash', identity: 'file', kind: 'file' },
    usage,
  }
}

function fakeDiagnostic(message: string): Diagnostic {
  return { filePath: '/repo/source.ts', message, ruleId: 'plugin/rule', severity: 'warn' }
}

function fakeUsage(modelId: string): InferenceUsageRecord {
  return { modelId, providerId: 'local', ruleId: 'plugin/rule' }
}
