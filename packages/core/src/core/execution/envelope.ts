import type { CacheEntry } from '../cache'
import type { CacheRunContext } from '../targets/types'
import type { Diagnostic, ProgressPath } from '../types'
import type { RunProgress } from './progress'
import type { RuleExecutionObservation } from './projection'
import type { RuleExecutionJob, RuleExecutionOutcome } from './types'

import { errorMessageFrom } from '@moeru/std/error'

import packageJson from '../../../package.json'

import { createCacheKey, normalizeCachePath, stableHash } from '../cache'

export interface ExecuteRuleExecutionJobOptions {
  cache: CacheRunContext
  cacheOnly?: boolean
  clock: () => number
  observation: RuleExecutionObservation
  progress: Pick<RunProgress, 'emit'>
  runSignal?: AbortSignal
  timeoutMs?: number
}

class CacheReplayProcessingError {
  constructor(readonly cause: unknown) {}
}

export async function executeRuleExecutionJob(
  job: RuleExecutionJob,
  options: ExecuteRuleExecutionJobOptions,
): Promise<RuleExecutionOutcome> {
  const timeoutMs = resolveRuleExecutionTimeout(options.timeoutMs)
  const startedAt = options.clock()
  const { bucket } = options.observation
  options.progress.emit('onRuleStart', { path: job.path, startedAt })
  if (options.runSignal?.aborted)
    return finish(job, options, bucket, startedAt, { cache: 'miss', state: 'cancelled' })

  {
    const cacheKey = createExecutionCacheKey(job, options.cache)
    const cachedEntry = cacheKey ? options.cache.store.get(cacheKey) : undefined
    if (cacheKey && cachedEntry) {
      rememberCacheEntry(options.cache, job.target.cacheFilePaths, cacheKey)
      options.observation.markCached()
      try {
        replayCachedEntry(cachedEntry, bucket, job.path, options)
      }
      catch (error) {
        if (!(error instanceof CacheReplayProcessingError))
          throw error
        const { cause } = error
        return finish(job, options, bucket, startedAt, {
          cache: 'hit',
          cause,
          failure: failure(cause, job, 'cache-replay'),
          state: 'failed',
        })
      }

      return finish(job, options, bucket, startedAt, { cache: 'hit', state: 'cached' })
    }

    if (options.cacheOnly)
      return finish(job, options, bucket, startedAt, { cache: 'miss', state: 'skipped' })

    const controller = new AbortController()
    let timedOut = false
    let deadlineError: Error | undefined
    const forwardRunAbort = () => controller.abort(options.runSignal?.reason)
    if (options.runSignal?.aborted)
      forwardRunAbort()
    else
      options.runSignal?.addEventListener('abort', forwardRunAbort, { once: true })

    const timer = timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true
          deadlineError = new Error(`Rule execution timed out after ${timeoutMs}ms.`)
          controller.abort(deadlineError)
        }, timeoutMs)

    let handlerCause: unknown
    let handlerFailed = false

    try {
      // NOTICE: JavaScript handlers cannot be force-terminated. A timed-out handler keeps its permit until its promise settles; process isolation would require a separately approved runtime design.
      await job.execution.runtime.executionState.run({
        activeFilePath: job.target.activeFilePath,
        bucket,
        progressPath: job.path,
        signal: controller.signal,
      }, job.execution.run)
    }
    catch (cause) {
      handlerCause = cause
      handlerFailed = true
    }
    finally {
      if (timer !== undefined)
        clearTimeout(timer)
      options.runSignal?.removeEventListener('abort', forwardRunAbort)
    }

    if (options.runSignal?.aborted)
      return finish(job, options, bucket, startedAt, { cache: 'miss', state: 'cancelled' })

    if (timedOut) {
      return finish(job, options, bucket, startedAt, {
        cache: 'miss',
        cause: deadlineError,
        failure: failure(deadlineError, job, 'timeout'),
        state: 'failed',
      })
    }

    if (handlerFailed) {
      return finish(job, options, bucket, startedAt, {
        cache: 'miss',
        cause: handlerCause,
        failure: failure(handlerCause, job, 'handler'),
        state: 'failed',
      })
    }

    if (cacheKey) {
      try {
        options.cache.store.set(cacheKey, createCacheEntry(job, options.cache, bucket))
        rememberCacheEntry(options.cache, job.target.cacheFilePaths, cacheKey)
      }
      catch {
        // NOTICE: Cache writes are opportunistic and no cache logging boundary exists yet;
        // a write failure cannot invalidate successful rule work.
      }
    }

    return finish(job, options, bucket, startedAt, { cache: 'miss', state: 'completed' })
  }
}

export function resolveRuleExecutionTimeout(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined)
    return undefined
  if (!Number.isFinite(timeoutMs) || !Number.isInteger(timeoutMs) || timeoutMs <= 0)
    throw new TypeError('Rule execution timeout must be a finite positive integer.')
  return timeoutMs
}

function cloneDiagnostic(diagnostic: Diagnostic): Diagnostic {
  return {
    ...diagnostic,
    loc: diagnostic.loc
      ? {
          end: diagnostic.loc.end ? { ...diagnostic.loc.end } : undefined,
          start: { ...diagnostic.loc.start },
        }
      : undefined,
    model: diagnostic.model ? { ...diagnostic.model } : undefined,
  }
}

function createCacheEntry(
  job: RuleExecutionJob,
  cache: CacheRunContext,
  bucket: RuleExecutionOutcome['bucket'],
): CacheEntry {
  return {
    diagnostics: bucket.diagnostics.map(cloneDiagnostic),
    filePath: normalizeCachePath(cache.cwd, job.path.plan.path),
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
    usage: bucket.usage.map(record => ({ ...record })),
  }
}

function createExecutionCacheKey(job: RuleExecutionJob, cache: CacheRunContext): string | undefined {
  if (!cache.enabled || !job.execution.runtime.cacheable || job.target.cacheFilePaths.length === 0)
    return undefined

  return createCacheKey({
    alintVersion: packageJson.version,
    configHash: job.target.configHash,
    filePath: normalizeCachePath(cache.cwd, job.path.plan.path),
    modelHash: cache.modelHash,
    ruleHash: job.execution.runtime.ruleHash,
    schemaVersion: 1,
    targetHash: createTargetHash(job),
    targetIdentity: job.target.identity,
    targetKind: job.target.kind,
  })
}

function createTargetHash(job: RuleExecutionJob): string {
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

function failure(
  cause: unknown,
  job: RuleExecutionJob,
  kind: NonNullable<RuleExecutionOutcome['failure']>['kind'],
): NonNullable<RuleExecutionOutcome['failure']> {
  return {
    kind,
    message: errorMessageFrom(cause) ?? String(cause),
    path: job.path,
  }
}

function finish(
  job: RuleExecutionJob,
  options: ExecuteRuleExecutionJobOptions,
  bucket: RuleExecutionOutcome['bucket'],
  startedAt: number,
  terminal: RuleExecutionOutcome extends infer Outcome
    ? Outcome extends RuleExecutionOutcome
      ? Omit<Outcome, 'bucket' | 'job'>
      : never
    : never,
): RuleExecutionOutcome {
  const outcome = { bucket, job, ...terminal }
  options.progress.emit('onRuleEnd', {
    cache: outcome.cache,
    endedAt: options.clock(),
    failure: outcome.failure,
    path: job.path,
    startedAt,
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
  bucket: RuleExecutionOutcome['bucket'],
  path: ProgressPath,
  options: Pick<ExecuteRuleExecutionJobOptions, 'observation' | 'progress'>,
): void {
  let diagnostics: CacheEntry['diagnostics']
  let usageRecords: CacheEntry['usage']
  try {
    diagnostics = entry.diagnostics.map(cloneDiagnostic)
    usageRecords = entry.usage.map(record => ({ ...record }))
  }
  catch (cause) {
    throw new CacheReplayProcessingError(cause)
  }

  for (const cachedDiagnostic of diagnostics) {
    const diagnostic = { ...cachedDiagnostic, cached: true }
    bucket.diagnostics.push(diagnostic)
    const projected = options.observation.diagnostics()
    options.progress.emit('onDiagnostic', {
      diagnostic,
      diagnostics: projected,
      path,
    })
  }

  for (const cachedUsage of usageRecords) {
    const usage = { ...cachedUsage }
    bucket.usage.push(usage)
    options.progress.emit('onUsage', { path, record: usage, total: options.observation.usage() })
  }
}
