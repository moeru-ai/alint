import type { CacheEntry } from '../cache'
import type { CacheRunContext, ExecutionTarget, RuleExecutionBucket, RuleRuntimeState, RuleTargetExecution, TargetExecutionPlan } from '../targets/types'
import type { AlintRunFailure, Diagnostic, ProgressJob, ProgressReporter } from '../types'

import { errorMessageFrom } from '@moeru/std/error'

import packageJson from '../../../package.json'

import { createCacheKey, normalizeCachePath, stableHash } from '../cache'

export interface ExecuteRuleJobOptions {
  cache: CacheRunContext
  cacheOnly?: boolean
  clock: () => number
  progress?: ProgressReporter
  runSignal?: AbortSignal
  startedAt: number
  timeoutMs?: number
}

export interface RuleJob {
  execution: RuleTargetExecution
  job: ProgressJob
  target: ExecutionTarget
}

export type RuleJobOutcome = RuleJobOutcomeBase & (
  | { cache: 'hit', cause?: never, failure?: never, state: 'cached' }
  | { cache: 'hit' | 'miss', cause: unknown, failure: AlintRunFailure, state: 'failed' }
  | { cache: 'miss', cause?: never, failure?: never, state: 'cancelled' | 'completed' | 'skipped' }
)

interface RuleJobOutcomeBase {
  bucket: RuleExecutionBucket
  job: RuleJob
}

class CacheReplayProcessingError {
  constructor(readonly cause: unknown) {}
}

export function createRuleJobs(plans: TargetExecutionPlan[]): RuleJob[] {
  const jobs: RuleJob[] = []
  const total = plans.reduce((sum, plan) => sum + plan.planned, 0)

  for (const plan of plans) {
    for (const target of plan.targets) {
      for (const execution of target.executions) {
        const ruleId = execution.runtime.enabledRule.id
        const index = jobs.length + 1
        jobs.push({
          execution,
          job: {
            id: stableHash({ index, planId: plan.id, ruleId, targetIdentity: target.identity }),
            index,
            inputPath: plan.path,
            ruleId,
            target: {
              identity: target.identity,
              kind: target.kind,
              name: target.name,
            },
            total,
          },
          target,
        })
      }
    }
  }

  return jobs
}

export async function executeRuleJob(job: RuleJob, options: ExecuteRuleJobOptions): Promise<RuleJobOutcome> {
  const bucket: RuleExecutionBucket = { diagnostics: [], usage: [] }
  if (options.runSignal?.aborted)
    return finish(job, options, bucket, { cache: 'miss', state: 'cancelled' })

  const cacheKey = createExecutionCacheKey(job, options.cache)
  const cachedEntry = cacheKey ? options.cache.store.get(cacheKey) : undefined
  if (cacheKey && cachedEntry) {
    rememberCacheEntry(options.cache, job.target.cacheFilePaths, cacheKey)
    try {
      replayCachedEntry(cachedEntry, bucket, job.job, options.progress)
    }
    catch (error) {
      if (!(error instanceof CacheReplayProcessingError))
        throw error
      return finish(job, options, bucket, {
        cache: 'hit',
        cause: error.cause,
        failure: failure(error.cause, job, 'cache-replay'),
        state: 'failed',
      })
    }

    return finish(job, options, bucket, { cache: 'hit', state: 'cached' })
  }

  if (options.cacheOnly)
    return finish(job, options, bucket, { cache: 'miss', state: 'skipped' })

  const controller = new AbortController()
  let timedOut = false
  let deadlineError: Error | undefined
  const forwardRunAbort = () => controller.abort(options.runSignal?.reason)
  if (options.runSignal?.aborted)
    forwardRunAbort()
  else
    options.runSignal?.addEventListener('abort', forwardRunAbort, { once: true })

  const timer = options.timeoutMs == null
    ? undefined
    : setTimeout(() => {
        timedOut = true
        deadlineError = new Error(`Rule execution timed out after ${options.timeoutMs}ms.`)
        controller.abort(deadlineError)
      }, options.timeoutMs)

  const state: RuleRuntimeState = {
    activeFilePath: job.target.activeFilePath,
    bucket,
    job: job.job,
    reporterFailed: false,
    signal: controller.signal,
  }
  let handlerCause: unknown
  let handlerFailed = false

  try {
    // NOTICE: JavaScript handlers cannot be force-terminated. A timed-out handler keeps its permit until its promise settles; process isolation would require a separately approved runtime design.
    await job.execution.runtime.executionState.run(state, job.execution.run)
  }
  catch (cause) {
    if (state.reporterFailed)
      throw state.reporterCause
    handlerCause = cause
    handlerFailed = true
  }
  finally {
    if (timer != null)
      clearTimeout(timer)
    options.runSignal?.removeEventListener('abort', forwardRunAbort)
  }

  if (state.reporterFailed)
    throw state.reporterCause

  if (!timedOut && !handlerFailed && cacheKey) {
    try {
      options.cache.store.set(cacheKey, createCacheEntry(job, options.cache, bucket))
      rememberCacheEntry(options.cache, job.target.cacheFilePaths, cacheKey)
    }
    catch {
      // NOTICE: Cache writes are opportunistic and no cache logging boundary exists yet;
      // a write failure cannot invalidate successful rule work.
    }
  }

  if (options.runSignal?.aborted)
    return finish(job, options, bucket, { cache: 'miss', state: 'cancelled' })

  if (timedOut) {
    return finish(job, options, bucket, {
      cache: 'miss',
      cause: deadlineError,
      failure: failure(deadlineError, job, 'timeout'),
      state: 'failed',
    })
  }

  if (handlerFailed) {
    return finish(job, options, bucket, {
      cache: 'miss',
      cause: handlerCause,
      failure: failure(handlerCause, job, 'handler'),
      state: 'failed',
    })
  }

  return finish(job, options, bucket, { cache: 'miss', state: 'completed' })
}

export function resolveRuleExecutionTimeout(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined)
    return undefined
  if (!Number.isFinite(timeoutMs) || !Number.isInteger(timeoutMs) || timeoutMs <= 0)
    throw new TypeError('Rule execution timeout must be a finite positive integer.')
  return timeoutMs
}

function createCacheEntry(job: RuleJob, cache: CacheRunContext, bucket: RuleExecutionBucket): CacheEntry {
  return {
    diagnostics: bucket.diagnostics,
    filePath: normalizeCachePath(cache.cwd, job.job.inputPath),
    fingerprint: {
      alintVersion: packageJson.version,
      configHash: job.target.configHash,
      modelHash: cache.modelHash,
      ruleHash: job.execution.runtime.ruleHash,
    },
    target: {
      hash: createTargetHash(job),
      identity: job.target.identity,
      kind: job.target.kind,
      loc: job.target.loc,
      name: job.target.name,
      range: job.target.range,
    },
    usage: bucket.usage,
  }
}

function createExecutionCacheKey(job: RuleJob, cache: CacheRunContext): string | undefined {
  if (!cache.enabled || !job.execution.runtime.cacheable || job.target.cacheFilePaths.length === 0)
    return undefined

  return createCacheKey({
    alintVersion: packageJson.version,
    configHash: job.target.configHash,
    filePath: normalizeCachePath(cache.cwd, job.job.inputPath),
    modelHash: cache.modelHash,
    ruleHash: job.execution.runtime.ruleHash,
    schemaVersion: 1,
    targetHash: createTargetHash(job),
    targetIdentity: job.target.identity,
    targetKind: job.target.kind,
  })
}

function createTargetHash(job: RuleJob): string {
  const target = job.target
  return stableHash({
    language: target.language,
    loc: target.loc,
    metadata: target.metadata,
    name: target.name,
    origin: target.origin,
    range: target.range,
    text: target.text,
  })
}

function failure(cause: unknown, job: RuleJob, kind: AlintRunFailure['kind']): AlintRunFailure {
  return {
    job: job.job,
    kind,
    message: errorMessageFrom(cause) ?? String(cause),
  }
}

function finish(
  job: RuleJob,
  options: ExecuteRuleJobOptions,
  bucket: RuleExecutionBucket,
  terminal: RuleJobOutcome extends infer Outcome
    ? Outcome extends RuleJobOutcome
      ? Omit<Outcome, 'bucket' | 'job'>
      : never
    : never,
): RuleJobOutcome {
  const outcome = { bucket, job, ...terminal } as RuleJobOutcome
  options.progress?.onJobEnd?.({
    cache: outcome.cache,
    endedAt: options.clock(),
    failure: outcome.failure,
    job: job.job,
    startedAt: options.startedAt,
    state: outcome.state,
  })
  return outcome
}

function rememberCacheEntry(cache: CacheRunContext, filePaths: string[], cacheKey: string): void {
  for (const filePath of filePaths) {
    const normalizedPath = normalizeCachePath(cache.cwd, filePath)
    const entries = cache.fileEntryKeys.get(normalizedPath) ?? new Set<string>()
    entries.add(cacheKey)
    cache.fileEntryKeys.set(normalizedPath, entries)
  }
}

function replayCachedEntry(
  entry: CacheEntry,
  bucket: RuleExecutionBucket,
  job: ProgressJob,
  progress: ProgressReporter | undefined,
): void {
  let diagnostics: CacheEntry['diagnostics']
  let usage: CacheEntry['usage']
  try {
    diagnostics = entry.diagnostics
    usage = entry.usage
  }
  catch (cause) {
    throw new CacheReplayProcessingError(cause)
  }

  for (const cachedDiagnostic of diagnostics) {
    const diagnostic: Diagnostic = { ...cachedDiagnostic, cached: true }
    bucket.diagnostics.push(diagnostic)
    progress?.onDiagnostic?.({ diagnostic, job })
  }

  for (const record of usage) {
    bucket.usage.push(record)
    progress?.onUsage?.({ job, record })
  }
}
