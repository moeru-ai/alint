import type { SetupConfig } from '../config/types'
import type { CacheStore } from './cache'
import type { RuleJobOutcome } from './execution/types'
import type { ProjectFileSnapshot, ProjectIndex } from './project/types'
import type { PreparedDirectory } from './targets/directory'
import type { CacheRunContext, PreparedFile, PreparedFileExecutionPlan, RuleRuntime, TargetExecutionPlan } from './targets/types'
import type { AlintRunFailure, InferenceUsageRecord, RunOptions, RunResult, RunUsage, RunUsageTotals } from './types'

import { cwd as processCwd } from 'node:process'

import { createCacheStore, normalizeRunnerCacheConfig } from './cache'
import { compareJobOrder, createRuleJobs, executeRuleJob, resolveRuleExecutionTimeout } from './execution/job'
import { createRunProgress, groupJobsForAdmission } from './execution/progress'
import { snapshotDiagnostics, snapshotProgressJobRef, snapshotUsageRecords } from './execution/records'
import { createRuleRuntimes } from './execution/runtime'
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
  const allPlans = [...filePlans, ...directoryPlans, ...(projectPlan ? [projectPlan] : [])]
  const jobs = createRuleJobs(allPlans)
  const settledOutcomes = new Array<RuleJobOutcome | undefined>(jobs.length)
  const lifecycles: Array<'queued' | 'running' | 'terminal' | 'unadmitted'> = jobs.map(() => 'unadmitted')
  const admissionGroups = groupJobsForAdmission(jobs)
  let infrastructureError: unknown
  let infrastructureFailed = false
  let admissionFailed = false
  let shouldReconcile = false

  try {
    for (const [fileIndex, file] of files.entries()) {
      let jobsAdded = 0
      for (const { index: jobIndex, job } of admissionGroups.sourceByInput[fileIndex] ?? []) {
        const progress = runProgress.queue()
        lifecycles[jobIndex] = 'queued'
        jobsAdded += 1
        options.progress?.onJobQueued?.({ job: snapshotProgressJobRef(job.jobRef), progress })
      }
      options.progress?.onFileReady?.({
        fileIndex: file.fileIndex,
        inputPath: file.file.path,
        jobsAdded,
        progress: runProgress.snapshot(),
      })
    }
    for (const { index: jobIndex, job } of admissionGroups.nonSource) {
      const progress = runProgress.queue()
      lifecycles[jobIndex] = 'queued'
      options.progress?.onJobQueued?.({ job: snapshotProgressJobRef(job.jobRef), progress })
    }
    shouldReconcile = true

    let cursor = 0
    const worker = async (): Promise<void> => {
      while (cursor < jobs.length && !infrastructureFailed) {
        const index = cursor
        cursor += 1
        const job = jobs[index]!
        if (lifecycles[index] !== 'queued')
          continue
        if (options.signal?.aborted) {
          cancelQueuedJob(job, runProgress, options.progress, clock, (outcome) => {
            settledOutcomes[index] = outcome
            lifecycles[index] = 'terminal'
          })
          continue
        }
        try {
          const startedAt = clock()
          const progress = runProgress.start()
          lifecycles[index] = 'running'
          options.progress?.onJobStart?.({ job: snapshotProgressJobRef(job.jobRef), progress, startedAt })
          const outcome = await executeRuleJob(job, {
            cache: cacheContext,
            cacheOnly: options.cacheOnly,
            clock,
            onTerminal: (terminalOutcome) => {
              settledOutcomes[index] = terminalOutcome
              lifecycles[index] = 'terminal'
            },
            progress: options.progress,
            runProgress,
            runSignal: options.signal,
            startedAt,
            timeoutMs,
          })
          settledOutcomes[index] = outcome
        }
        catch (error) {
          if (!infrastructureFailed) {
            infrastructureError = error
            infrastructureFailed = true
          }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker))
  }
  catch (error) {
    infrastructureError = error
    infrastructureFailed = true
    admissionFailed = true
  }
  finally {
    // cacheOnly runs are strictly read-only: reconciling a partial cache snapshot could
    // discard entries for the jobs deliberately skipped by this run.
    if (shouldReconcile && !options.cacheOnly)
      await reconcileCache(filePlans, projectPlan, cacheStore, options.signal?.aborted === true)
  }

  for (const [index, lifecycle] of lifecycles.entries()) {
    if (lifecycle === 'queued') {
      settledOutcomes[index] = cancelQueuedJob(jobs[index]!, runProgress)
      lifecycles[index] = 'terminal'
    }
    else if (lifecycle === 'running') {
      runProgress.finish('running', 'cancelled')
      settledOutcomes[index] = cancelledOutcome(jobs[index]!)
      lifecycles[index] = 'terminal'
    }
  }

  runProgress.finalize()
  if (admissionFailed)
    throw infrastructureError

  const outcomes = settledOutcomes.filter((outcome): outcome is RuleJobOutcome => outcome !== undefined)
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

function cancelledOutcome(job: ReturnType<typeof createRuleJobs>[number]): RuleJobOutcome {
  return {
    cache: 'miss',
    diagnostics: [],
    jobRef: snapshotProgressJobRef(job.jobRef),
    orderKey: { ...job.orderKey },
    state: 'cancelled',
    usage: [],
  }
}

function cancelQueuedJob(
  job: ReturnType<typeof createRuleJobs>[number],
  progress: ReturnType<typeof createRunProgress>,
  reporter?: RunOptions['progress'],
  clock?: () => number,
  onTerminal?: (outcome: RuleJobOutcome) => void,
): RuleJobOutcome {
  const outcome = cancelledOutcome(job)
  const snapshot = progress.finish('queued', 'cancelled')
  onTerminal?.(outcome)
  reporter?.onJobEnd?.({
    cache: 'miss',
    endedAt: clock?.(),
    job: snapshotProgressJobRef(job.jobRef),
    progress: snapshot,
    state: 'cancelled',
  })
  return outcome
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

function resolveRuleConcurrency(ruleConcurrency: number | undefined): number {
  if (ruleConcurrency === undefined)
    return 4
  if (!Number.isFinite(ruleConcurrency) || !Number.isInteger(ruleConcurrency) || ruleConcurrency <= 0)
    throw new TypeError('Rule execution concurrency must be a finite positive integer.')
  return ruleConcurrency
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
