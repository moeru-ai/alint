import type { SetupConfig } from '../config/types'
import type { CacheStore } from './cache'
import type { ScheduledRuleBatch } from './execution/scheduler'
import type { RuleJobOutcome } from './execution/types'
import type { ProjectFileSnapshot, ProjectIndex } from './project/types'
import type { PreparedDirectory } from './targets/directory'
import type { CacheRunContext, PreparedFile, PreparedFileExecutionPlan, RuleRuntime, TargetExecutionPlan } from './targets/types'
import type { AlintRunFailure, InferenceUsageRecord, RunOptions, RunResult, RunUsage, RunUsageTotals } from './types'

import { cwd as processCwd } from 'node:process'

import { createCacheStore, normalizeRunnerCacheConfig } from './cache'
import { compareJobOrder, createRuleJobFactory, executeRuleJob, resolveRuleExecutionTimeout } from './execution/job'
import { createRunProgress } from './execution/progress'
import { snapshotDiagnostics, snapshotUsageRecords } from './execution/records'
import { createRuleRuntimes } from './execution/runtime'
import { resolveRuleConcurrency, RuleScheduler } from './execution/scheduler'
import { hashText, stableHash } from './hash'
import { prepareRun } from './preparation'
import { ProjectIndexBuilder } from './project'
import { createSourceRuntime } from './source/runtime'
import { createDirectoryExecutionPlans } from './targets/directory'
import { createProjectExecutionPlan } from './targets/project'
import { createSourceExecutionPlans } from './targets/source'

export class AlintRunCancelledError extends Error {
  readonly result: RunResult

  constructor(result: RunResult, cause?: unknown) {
    super('Alint run cancelled.', { cause })
    this.name = 'AlintRunCancelledError'
    this.result = result
  }
}

/** Cancellation error carrying the partial result gathered before the abort. */
export class AlintAbortError extends AlintRunCancelledError {
  constructor(result: RunResult, options: { cause?: unknown } = {}) {
    super(result, options.cause)
    this.name = 'AlintAbortError'
  }
}

export class AlintRunError extends Error {
  readonly failures: AlintRunFailure[]
  readonly result: RunResult

  constructor(message: string, result: RunResult, options: { cause?: unknown, failures?: AlintRunFailure[] } = {}) {
    super(message, { cause: options.cause })
    this.name = 'AlintRunError'
    this.failures = options.failures ?? []
    this.result = result
  }
}

export async function runAlint(options: RunOptions = {}): Promise<RunResult> {
  const clock = Date.now
  const timeoutMs = resolveRuleExecutionTimeout(options.runner?.timeoutMs)
  const concurrency = resolveRuleConcurrency(options.runner?.ruleConcurrency)
  const prepareStartedAt = clock()
  options.progress?.onPrepareStart?.({ startedAt: prepareStartedAt })
  const preparation = prepareRun(options)
  options.progress?.onPrepareEnd?.({ endedAt: clock(), filesTotal: preparation.files.length, startedAt: prepareStartedAt })
  const runProgress = createRunProgress(preparation.files.length)
  const runStartedAt = clock()
  options.progress?.onExecuteStart?.({ progress: runProgress.snapshot(), startedAt: runStartedAt })
  const cwd = options.cwd ?? processCwd()
  const setupConfig: SetupConfig = options.setupConfig ?? { providers: [], version: 1 }
  const src = createSourceRuntime()
  const normalizedCacheConfig = normalizeRunnerCacheConfig(options.runner?.cache, cwd)
  const cacheStore = await createCacheStore({
    cwd,
    enabled: normalizedCacheConfig.enabled,
    location: normalizedCacheConfig.location,
    readOnly: options.cacheOnly,
  })

  const cacheContext: CacheRunContext = {
    modelHash: stableHash({
      modelOverride: options.modelOverride,
      outputLanguage: options.outputLanguage,
      setupConfig,
    }),
  }

  const files = await Promise.all(preparation.files.map(async (input): Promise<PreparedFile> => {
    const file = await src.readFile(input.path)
    const targets = await input.language.extract(file, {
      cwd,
      languageOptions: input.languageOptions,
      src,
    })
    const ruleRuntimes = createRuleRuntimes({
      cwd,
      effectiveAgent: input.agent,
      effectiveSettings: input.settings,
      progress: options.progress,
      rules: input.rules,
      runOptions: options,
      runProgress,
      setupConfig,
      src,
    })

    return {
      configHash: input.configHash,
      file,
      fileIndex: input.fileIndex,
      ruleRuntimes,
      targets,
    }
  }))

  const directories = preparation.directories.map((input): PreparedDirectory => {
    return {
      ...input,
      ruleRuntimes: createRuleRuntimes({
        cwd,
        effectiveAgent: input.agent,
        effectiveSettings: input.settings,
        progress: options.progress,
        rules: input.rules,
        runOptions: options,
        runProgress,
        setupConfig,
        src,
      }),
    }
  })

  const projectRuleRuntimes = preparation.project
    ? createRuleRuntimes({
        cwd,
        effectiveAgent: preparation.project.agent,
        effectiveSettings: preparation.project.settings,
        progress: options.progress,
        rules: preparation.project.rules,
        runOptions: options,
        runProgress,
        setupConfig,
        src,
      })
    : []
  const filePlans = createSourceExecutionPlans(files, cwd, cacheStore)
  const directoryPlans = createDirectoryExecutionPlans(directories, filePlans.length)
  const projectPlan = preparation.project && canCreateProjectPlan(projectRuleRuntimes)
    ? createProjectExecutionPlan({
        cacheStore,
        configHash: preparation.project.configHash,
        index: filePlans.length + directoryPlans.length + 1,
        project: createProjectIndex(preparation.project.root, files),
        ruleRuntimes: projectRuleRuntimes,
      })
    : undefined
  const jobFactory = createRuleJobFactory()
  const batches: ScheduledRuleBatch[] = []
  const scheduler = new RuleScheduler({
    clock,
    concurrency,
    execute: (job, _startedAt) => executeRuleJob(job, {
      cache: cacheContext,
      cacheOnly: options.cacheOnly,
      progress: options.progress,
      runProgress,
      runSignal: options.signal,
      timeoutMs,
    }),
    progress: runProgress,
    reporter: options.progress,
    signal: options.signal,
  })
  let infrastructureError: unknown
  let infrastructureFailed = false
  let admissionFailed = false

  try {
    for (const [fileIndex, filePlan] of filePlans.entries()) {
      const batch = scheduler.schedule(jobFactory.create([filePlan]))
      batches.push(batch)
      const file = files[fileIndex]!
      options.progress?.onFileReady?.({
        fileIndex: file.fileIndex,
        inputPath: file.file.path,
        jobsAdded: batch.jobsAdded,
        progress: runProgress.snapshot(),
      })
    }
    for (const plan of directoryPlans)
      batches.push(scheduler.schedule(jobFactory.create([plan])))
    if (projectPlan)
      batches.push(scheduler.schedule(jobFactory.create([projectPlan])))
  }
  catch (error) {
    scheduler.cancelWithError(error)
    infrastructureError = error
    infrastructureFailed = true
    admissionFailed = true
  }
  finally {
    const batchResults = Promise.all(batches.map(batch => batch.outcomes))
    const [outcomesResult, closeResult] = await Promise.allSettled([batchResults, scheduler.close()])
    if (outcomesResult.status === 'rejected' || closeResult.status === 'rejected') {
      infrastructureError ??= outcomesResult.status === 'rejected' ? outcomesResult.reason : closeResult.status === 'rejected' ? closeResult.reason : undefined
      infrastructureFailed = true
    }
    // cacheOnly runs are strictly read-only: reconciling a partial cache snapshot could
    // discard entries for the jobs deliberately skipped by this run.
    if (!admissionFailed && !options.cacheOnly)
      await reconcileCache(filePlans, projectPlan, cacheStore, options.signal?.aborted === true)
  }

  runProgress.finalize()
  if (admissionFailed)
    throw infrastructureError

  const settledBatches = await Promise.allSettled(batches.map(batch => batch.outcomes))
  const outcomes = settledBatches.flatMap(result => result.status === 'fulfilled' ? result.value : [])
    .sort((left, right) => compareJobOrder(left.orderKey, right.orderKey))
  const failedOutcomes = outcomes.filter(
    (outcome): outcome is Extract<RuleJobOutcome, { state: 'failed' }> => outcome.state === 'failed',
  )
  const failures = failedOutcomes.map(outcome => outcome.failure)
  const result: RunResult = {
    diagnostics: outcomes.flatMap(outcome => outcome.diagnostics),
    execution: executionCounts(outcomes),
    usage: runUsage(outcomes),
  }

  options.progress?.onExecuteEnd?.({ endedAt: clock(), progress: runProgress.snapshot() })
  options.progress?.onRunEnd?.({
    diagnostics: snapshotDiagnostics(result.diagnostics),
    endedAt: clock(),
    execution: { ...result.execution },
    progress: runProgress.snapshot(),
    startedAt: runStartedAt,
    usage: snapshotRunUsage(result.usage),
  })

  if (infrastructureFailed)
    throw infrastructureError
  if (options.signal?.aborted)
    throw new AlintAbortError(result, { cause: options.signal.reason })
  if (failures.length > 0) {
    throw new AlintRunError(`${failures.length} rule execution${failures.length === 1 ? '' : 's'} failed.`, result, {
      cause: new AggregateError(failures.map(failure => new Error(failure.message)), 'Rule execution failures.'),
      failures,
    })
  }

  return result
}

function canCreateProjectPlan(runtimes: RuleRuntime[]): boolean {
  return runtimes.some(runtime => runtime.handlers.onTargetWith || runtime.handlers.onTargetProject)
}

function createProjectFileSnapshot(preparedFile: PreparedFile): ProjectFileSnapshot {
  return {
    configHash: preparedFile.configHash,
    file: {
      contentHash: hashText(preparedFile.file.text),
      language: preparedFile.file.language,
      path: preparedFile.file.path,
      targetCount: preparedFile.targets.length,
    },
    fileIndex: preparedFile.fileIndex,
    targets: preparedFile.targets.map(target => ({
      descriptor: {
        filePath: target.file.path,
        identity: target.identity,
        kind: target.kind,
        ...(target.name === undefined ? {} : { name: target.name }),
        ...(target.range === undefined ? {} : { range: target.range }),
      },
      semanticHash: stableHash({
        language: target.language,
        loc: target.loc,
        metadata: target.metadata,
        name: target.name,
        origin: target.origin,
        range: target.range,
        text: target.text,
      }),
    })),
  }
}

function createProjectIndex(root: string, files: PreparedFile[]): ProjectIndex {
  const builder = new ProjectIndexBuilder(root)

  files.forEach(file => builder.add(createProjectFileSnapshot(file)))

  return builder.build()
}

function executionCounts(outcomes: RuleJobOutcome[]): RunResult['execution'] {
  const counts: RunResult['execution'] = {
    cached: 0,
    cancelled: 0,
    completed: 0,
    failed: 0,
    planned: outcomes.length,
    queued: 0,
    running: 0,
    skipped: 0,
  }
  for (const outcome of outcomes)
    counts[outcome.state] += 1
  return counts
}

async function reconcileCache(
  filePlans: PreparedFileExecutionPlan[],
  projectPlan: TargetExecutionPlan | undefined,
  cacheStore: CacheStore,
  externallyAborted: boolean,
): Promise<void> {
  try {
    for (const filePlan of filePlans) {
      const file = filePlan.preparedFile.file
      filePlan.cacheOwner.commit({
        contentHash: hashText(file.text),
        mode: externallyAborted ? 'merge' : 'replace',
      })
    }

    projectPlan?.targets[0]?.cacheOwner?.commit({ mode: externallyAborted ? 'merge' : 'replace' })

    await cacheStore.reconcile()
  }
  catch {
    // Cache writes are opportunistic and must not mask lint results.
  }
}

function runUsage(outcomes: RuleJobOutcome[]): RunUsage {
  const live: InferenceUsageRecord[] = []
  const cached: InferenceUsageRecord[] = []
  for (const outcome of outcomes) {
    (outcome.state === 'cached' ? cached : live).push(...outcome.usage)
  }

  return {
    ...usageTotals(live),
    ...(cached.length > 0 ? { cached: usageTotals(cached) } : {}),
  }
}

function snapshotRunUsage(usage: RunUsage): RunUsage {
  return {
    ...usage,
    ...(usage.cached
      ? { cached: { ...usage.cached, records: snapshotUsageRecords(usage.cached.records) } }
      : {}),
    records: snapshotUsageRecords(usage.records),
  }
}

function usageTotals(records: InferenceUsageRecord[]): RunUsageTotals {
  let inputTokens = 0
  let outputTokens = 0
  let totalTokens = 0
  for (const record of records) {
    if (record.inputTokens != null && Number.isFinite(record.inputTokens))
      inputTokens += record.inputTokens
    if (record.outputTokens != null && Number.isFinite(record.outputTokens))
      outputTokens += record.outputTokens
    if (record.totalTokens != null && Number.isFinite(record.totalTokens))
      totalTokens += record.totalTokens
  }
  return { inputTokens, outputTokens, records: [...records], totalTokens }
}
