import type { CacheEntry, CacheFingerprint, CacheSlotIdentity } from '../cache'
import type { CacheRunContext, RuleExecutionBucket, RuleRuntimeState, TargetExecutionPlan } from '../targets/types'
import type { AlintRunFailure, Diagnostic, ProgressJobRef, ProgressReporter } from '../types'
import type { RunProgress } from './progress'
import type { JobOrderKey, JobScope, RuleJob, RuleJobOutcome, TerminalOutcome } from './types'

import { errorMessageFrom } from '@moeru/std/error'

import { stableHash } from '../hash'
import { snapshotDiagnostic, snapshotDiagnostics, snapshotFailure, snapshotProgressJobRef, snapshotUsage, snapshotUsageRecords } from './records'

export interface ExecuteRuleJobOptions {
  cache: CacheRunContext
  cacheOnly?: boolean
  progress?: ProgressReporter
  runProgress: RunProgress
  runSignal?: AbortSignal
  timeoutMs?: number
}

export type { RuleJob, RuleJobOutcome } from './types'

export interface RuleJobFactory {
  create: (plans: readonly TargetExecutionPlan[]) => RuleJob[]
}

class CacheReplayProcessingError {
  constructor(readonly cause: unknown) {}
}

export function compareJobOrder(left: JobOrderKey, right: JobOrderKey): number {
  return scopeRank(left.scope) - scopeRank(right.scope)
    || left.inputIndex - right.inputIndex
    || left.targetIndex - right.targetIndex
    || left.ruleIndex - right.ruleIndex
}

export function createRuleJobFactory(): RuleJobFactory {
  let nextIndex = 1
  const inputIndexes: Record<JobScope, number> = { directory: 0, project: 0, source: 0 }

  return {
    create: plans => createRuleJobBatch(plans, inputIndexes, () => {
      const index = nextIndex
      nextIndex += 1
      return index
    }),
  }
}

export function createRuleJobs(plans: TargetExecutionPlan[]): RuleJob[] {
  return createRuleJobFactory().create(plans)
}

export async function executeRuleJob(job: RuleJob, options: ExecuteRuleJobOptions): Promise<RuleJobOutcome> {
  const bucket: RuleExecutionBucket = { diagnostics: [], usage: [] }
  if (options.runSignal?.aborted)
    return finish(job, bucket, { cache: 'miss', state: 'cancelled' })

  const slot: CacheSlotIdentity | undefined = job.target.cacheOwner && job.execution.runtime.cacheable
    ? {
        ruleId: job.execution.runtime.enabledRule.id,
        scope: job.target.kind,
        targetIdentity: job.target.identity,
      }
    : undefined
  const fingerprint = slot ? createFingerprint(job, options.cache.modelHash) : undefined
  const cachedEntry = slot && fingerprint ? job.target.cacheOwner?.lookup(slot, fingerprint) : undefined
  if (slot && cachedEntry) {
    try {
      replayCachedEntry(cachedEntry, bucket, job.jobRef, options.progress, options.runProgress)
    }
    catch (error) {
      if (!(error instanceof CacheReplayProcessingError))
        throw error
      job.target.cacheOwner?.discard(slot)
      return finish(job, bucket, {
        cache: 'hit',
        failure: failure(error.cause, job, 'cache-replay'),
        state: 'failed',
      })
    }

    return finish(job, bucket, { cache: 'hit', state: 'cached' })
  }

  if (options.cacheOnly)
    return finish(job, bucket, { cache: 'miss', state: 'skipped' })

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
    jobRef: job.jobRef,
    reporterFailed: false,
    runProgress: options.runProgress,
    sealed: false,
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
    state.sealed = true
    if (timer != null)
      clearTimeout(timer)
    options.runSignal?.removeEventListener('abort', forwardRunAbort)
  }

  if (state.reporterFailed)
    throw state.reporterCause

  if (options.runSignal?.aborted)
    return finish(job, bucket, { cache: 'miss', state: 'cancelled' })

  if (timedOut) {
    return finish(job, bucket, {
      cache: 'miss',
      failure: failure(deadlineError, job, 'timeout'),
      state: 'failed',
    })
  }

  if (handlerFailed) {
    return finish(job, bucket, {
      cache: 'miss',
      failure: failure(handlerCause, job, 'handler'),
      state: 'failed',
    })
  }

  if (slot && fingerprint) {
    try {
      job.target.cacheOwner?.put(slot, createCacheEntry(job, fingerprint, bucket))
    }
    catch {
      // NOTICE: Cache writes are opportunistic and no cache logging boundary exists yet;
      // a write failure cannot invalidate successful rule work.
    }
  }

  return finish(job, bucket, { cache: 'miss', state: 'completed' })
}

export function resolveRuleExecutionTimeout(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined)
    return undefined
  if (!Number.isFinite(timeoutMs) || !Number.isInteger(timeoutMs) || timeoutMs <= 0)
    throw new TypeError('Rule execution timeout must be a finite positive integer.')
  return timeoutMs
}

function createCacheEntry(job: RuleJob, fingerprint: CacheFingerprint, bucket: RuleExecutionBucket): CacheEntry {
  return {
    diagnostics: snapshotDiagnostics(bucket.diagnostics),
    fingerprint,
    target: {
      hash: fingerprint.targetHash,
      identity: job.target.identity,
      kind: job.target.kind,
      loc: job.target.loc
        ? {
            end: { column: job.target.loc.end.column, line: job.target.loc.end.line },
            start: { column: job.target.loc.start.column, line: job.target.loc.start.line },
          }
        : undefined,
      name: job.target.name,
      range: job.target.range
        ? { end: job.target.range.end, start: job.target.range.start }
        : undefined,
    },
    usage: snapshotUsageRecords(bucket.usage),
  }
}

function createFingerprint(job: RuleJob, modelHash: string): CacheFingerprint {
  return {
    configHash: job.target.configHash,
    modelHash,
    ruleHash: job.execution.runtime.ruleHash,
    targetHash: createTargetHash(job),
  }
}

function createRuleJobBatch(
  plans: readonly TargetExecutionPlan[],
  inputIndexes: Record<JobScope, number>,
  nextIndex: () => number,
): RuleJob[] {
  const jobs: RuleJob[] = []

  for (const plan of plans) {
    const scope = jobScope(plan.kind)
    const inputIndex = inputIndexes[scope]
    inputIndexes[scope] += 1
    for (const [targetIndex, target] of plan.targets.entries()) {
      for (const execution of target.executions) {
        const ruleId = execution.runtime.enabledRule.id
        const index = nextIndex()
        jobs.push({
          execution,
          jobRef: {
            id: stableHash({ index, planId: plan.id, ruleId, targetIdentity: target.identity }),
            index,
            inputPath: plan.path,
            ruleId,
            target: {
              identity: target.identity,
              kind: target.kind,
              name: target.name,
            },
          },
          orderKey: {
            inputIndex,
            ruleIndex: execution.runtime.ruleIndex,
            scope,
            targetIndex,
          },
          target,
        })
      }
    }
  }

  return jobs
}

function createTargetHash(job: RuleJob): string {
  const target = job.target
  return target.cacheTargetHash ?? stableHash({
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
    job: snapshotProgressJobRef(job.jobRef),
    kind,
    message: failureMessage(cause),
  }
}

function failureMessage(cause: unknown): string {
  try {
    return errorMessageFrom(cause) ?? 'Unknown rule failure.'
  }
  catch {
    return 'Unknown rule failure.'
  }
}

function finish(
  job: RuleJob,
  bucket: RuleExecutionBucket,
  terminal: TerminalOutcome,
): RuleJobOutcome {
  const detachedTerminal: TerminalOutcome = terminal.state === 'failed'
    ? { ...terminal, failure: snapshotFailure(terminal.failure) }
    : terminal
  const outcome: RuleJobOutcome = {
    diagnostics: snapshotDiagnostics(bucket.diagnostics),
    jobRef: snapshotProgressJobRef(job.jobRef),
    orderKey: { ...job.orderKey },
    usage: snapshotUsageRecords(bucket.usage),
    ...detachedTerminal,
  }
  return outcome
}

function jobScope(kind: TargetExecutionPlan['kind']): JobScope {
  return kind
}

function replayCachedEntry(
  entry: CacheEntry,
  bucket: RuleExecutionBucket,
  job: ProgressJobRef,
  progress: ProgressReporter | undefined,
  runProgress: RunProgress,
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
    const diagnostic: Diagnostic = snapshotDiagnostic({ ...cachedDiagnostic, cached: true })
    bucket.diagnostics.push(diagnostic)
    progress?.onDiagnostic?.({ diagnostic: snapshotDiagnostic(diagnostic), job: snapshotProgressJobRef(job), progress: runProgress.snapshot() })
  }

  for (const record of usage) {
    const usageRecord = snapshotUsage(record)
    bucket.usage.push(usageRecord)
    progress?.onUsage?.({ job: snapshotProgressJobRef(job), progress: runProgress.snapshot(), record: snapshotUsage(usageRecord) })
  }
}

function scopeRank(scope: JobScope): number {
  if (scope === 'source')
    return 0
  if (scope === 'directory')
    return 1
  return 2
}
