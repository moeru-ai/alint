import type { AgentAdapter } from '../agent/types'
import type { SetupConfig } from '../config/types'
import type { DirectoryTarget, RuleContext } from '../dsl/types'
import type { ModelRequirement, ResolvedModel } from '../models/types'
import type { RuleJobOutcome } from './execution/job'
import type { PreparedDirectory } from './targets/directory'
import type { CacheRunContext, PreparedFile, PreparedFileExecutionPlan, RuleRuntime, RuleRuntimeState } from './targets/types'
import type { AlintRunFailure, Diagnostic, InferenceUsageRecord, ProgressReporter, RunOptions, RunResult, RunUsage, RunUsageTotals } from './types'

import { AsyncLocalStorage } from 'node:async_hooks'
import { cwd as processCwd } from 'node:process'

import { resolve } from 'pathe'

import { combineAbortSignals } from '../agent'
import { withAgentRetry } from '../agent/retry'
import { resolveConfigForDirectory, resolveConfigForFile, resolveConfigForProject } from '../config/config-array'
import { buildRuleRegistry } from '../dsl/registry'
import { resolveModel } from '../models/resolve'
import { createCacheStore, hashText, normalizeCachePath, normalizeRunnerCacheConfig, stableHash } from './cache'
import { createRuleJobs, executeRuleJob, resolveRuleExecutionTimeout } from './execution/job'
import { createBuiltInLanguageRegistry, registerLanguage, resolveLanguage } from './languages'
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
  const timeoutMs = resolveRuleExecutionTimeout(options.runner?.timeoutMs)
  const concurrency = resolveRuleConcurrency(options.runner?.ruleConcurrency)
  const cwd = options.cwd ?? processCwd()
  const config = options.config ?? []
  const setupConfig: SetupConfig = options.setupConfig ?? { providers: [], version: 1 }
  const clock = Date.now
  const src = createSourceRuntime()
  const normalizedCacheConfig = normalizeRunnerCacheConfig(options.runner?.cache, cwd)
  const cacheStore = await createCacheStore({
    cwd,
    enabled: normalizedCacheConfig.enabled,
    location: normalizedCacheConfig.location,
  })

  const cacheContext: CacheRunContext = {
    cwd,
    enabled: normalizedCacheConfig.enabled,
    fileEntryKeys: new Map(),
    modelHash: stableHash({
      modelOverride: options.modelOverride,
      outputLanguage: options.outputLanguage,
      setupConfig,
    }),
    store: cacheStore,
  }

  const pendingFiles = [...(options.files ?? [])]
  const pendingDirectories = [...(options.directories ?? [])]

  const files = (await Promise.all(pendingFiles.map(async (filePath): Promise<PreparedFile | undefined> => {
    const file = await src.readFile(resolve(cwd, filePath))

    const resolvedConfig = resolveConfigForFile(file.path, config, { cwd })
    if (resolvedConfig.ignored) {
      return undefined
    }

    const effectiveConfig = resolvedConfig.config
    const languageRegistry = createBuiltInLanguageRegistry()

    for (const plugin of Object.values(effectiveConfig.plugins)) {
      for (const language of Object.values(plugin.languages ?? {})) {
        registerLanguage(languageRegistry, language)
      }
    }

    const language = resolveLanguage(file, languageRegistry, { language: effectiveConfig.language })
    const targets = await language.extract(file, { cwd, languageOptions: effectiveConfig.languageOptions, src })
    const registry = buildRuleRegistry(effectiveConfig)

    const ruleRuntimes = createRuleRuntimes({
      cwd,
      effectiveAgent: effectiveConfig.agent,
      effectiveSettings: effectiveConfig.settings,
      options,
      progress: options.progress,
      registry,
      setupConfig,
      src,
    })

    return {
      configHash: stableHash({
        language: effectiveConfig.language,
        languageOptions: effectiveConfig.languageOptions,
        processor: effectiveConfig.processor,
        resolvedLanguage: language.name,
        settings: effectiveConfig.settings,
      }),
      file,
      ruleRuntimes,
      targets,
    }
  }))).filter((file): file is PreparedFile => file !== undefined)

  const directories = pendingDirectories.map((directoryPath): PreparedDirectory | undefined => {
    const target: DirectoryTarget = {
      kind: 'directory',
      path: resolve(cwd, directoryPath),
    }

    const resolvedConfig = resolveConfigForDirectory(target.path, config, { cwd })
    if (resolvedConfig.ignored) {
      return undefined
    }

    const effectiveConfig = resolvedConfig.config
    const registry = buildRuleRegistry(effectiveConfig)

    return {
      configHash: stableHash({
        settings: effectiveConfig.settings,
      }),
      ruleRuntimes: createRuleRuntimes({
        cwd,
        effectiveAgent: effectiveConfig.agent,
        effectiveSettings: effectiveConfig.settings,
        options,
        progress: options.progress,
        registry,
        setupConfig,
        src,
      }),
      target,
    }
  }).filter((directory): directory is PreparedDirectory => directory !== undefined)

  const resolvedProjectConfig = resolveConfigForProject(cwd, config, { cwd })
  const projectConfig = resolvedProjectConfig.config
  const projectRuleRuntimes = resolvedProjectConfig.ignored
    ? []
    : createRuleRuntimes({
        cwd,
        effectiveAgent: projectConfig.agent,
        effectiveSettings: projectConfig.settings,
        options,
        progress: options.progress,
        registry: buildRuleRegistry(projectConfig),
        setupConfig,
        src,
      })
  const filePlans = createSourceExecutionPlans(files, cwd)
  const directoryPlans = createDirectoryExecutionPlans(directories, filePlans.length)
  const projectPlan = resolvedProjectConfig.ignored
    ? undefined
    : createProjectExecutionPlan({
        configHash: stableHash({ settings: projectConfig.settings }),
        files,
        index: filePlans.length + directoryPlans.length + 1,
        root: cwd,
        ruleRuntimes: projectRuleRuntimes,
      })
  const allPlans = [...filePlans, ...directoryPlans, ...(projectPlan ? [projectPlan] : [])]
  const jobs = createRuleJobs(allPlans)
  const runStartedAt = clock()
  const settledOutcomes = new Array<RuleJobOutcome | undefined>(jobs.length)
  let infrastructureError: unknown
  let infrastructureFailed = false

  options.progress?.onRunStart?.({
    jobsTotal: jobs.length,
    startedAt: runStartedAt,
  })
  for (const job of jobs)
    options.progress?.onJobQueued?.({ job: job.job })

  try {
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (cursor < jobs.length) {
        const index = cursor
        cursor += 1
        const job = jobs[index]!
        if (options.signal?.aborted) {
          settledOutcomes[index] = {
            bucket: { diagnostics: [], usage: [] },
            cache: 'miss',
            job,
            state: 'cancelled',
          }
          continue
        }
        try {
          const startedAt = clock()
          options.progress?.onJobStart?.({ job: job.job, startedAt })
          settledOutcomes[index] = await executeRuleJob(job, {
            cache: cacheContext,
            cacheOnly: options.cacheOnly,
            clock,
            progress: options.progress,
            runSignal: options.signal,
            startedAt,
            timeoutMs,
          })
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
  finally {
    // cacheOnly runs are strictly read-only: reconciling a partial cache snapshot could
    // discard entries for the jobs deliberately skipped by this run.
    if (!options.cacheOnly)
      await reconcileCache(filePlans, cacheContext)
  }

  const outcomes = Array.from({ length: jobs.length }, (_, index): RuleJobOutcome => settledOutcomes[index] ?? {
    bucket: { diagnostics: [], usage: [] },
    cache: 'miss',
    job: jobs[index]!,
    state: 'cancelled',
  })
  const failedOutcomes = outcomes.filter(
    (outcome): outcome is Extract<RuleJobOutcome, { state: 'failed' }> => outcome.state === 'failed',
  )
  const failures = failedOutcomes.map(outcome => outcome.failure)
  const result: RunResult = {
    diagnostics: outcomes.flatMap(outcome => outcome.bucket.diagnostics),
    execution: executionCounts(outcomes),
    usage: runUsage(outcomes),
  }

  options.progress?.onRunEnd?.({
    diagnostics: result.diagnostics,
    endedAt: clock(),
    execution: result.execution,
    startedAt: runStartedAt,
    usage: result.usage,
  })

  if (infrastructureFailed)
    throw infrastructureError
  if (options.signal?.aborted)
    throw new AlintAbortError(result, { cause: options.signal.reason })
  if (failures.length > 0) {
    throw new AlintRunError(`${failures.length} rule execution${failures.length === 1 ? '' : 's'} failed.`, result, {
      cause: new AggregateError(failedOutcomes.map(outcome => outcome.cause), 'Rule execution failures.'),
      failures,
    })
  }

  return result
}

function createRuleRuntimes(options: {
  cwd: string
  effectiveAgent: AgentAdapter | undefined
  effectiveSettings: Record<string, unknown>
  options: RunOptions
  progress?: ProgressReporter
  registry: ReturnType<typeof buildRuleRegistry>
  setupConfig: SetupConfig
  src: ReturnType<typeof createSourceRuntime>
}): RuleRuntime[] {
  return options.registry.enabledRules.map((enabledRule) => {
    const executionState = new AsyncLocalStorage<RuleRuntimeState>()
    const agent = options.effectiveAgent
      ? withAgentRetry(request => options.effectiveAgent!({
          ...request,
          signal: combineAbortSignals(executionState.getStore()?.signal, request.signal),
        }), options.options.runner?.agentRetries)
      : undefined
    const context: RuleContext<readonly unknown[]> = {
      agent,
      cwd: options.cwd,
      id: enabledRule.id,
      localId: enabledRule.localId,
      logger: {
        debug: () => {},
      },
      metering: {
        recordUsage: (record) => {
          const state = executionState.getStore()
          // TODO: (planning-observations) Create-time diagnostics and usage are rejected because they have no rule-job order; revisit only with an owner-approved planning evidence contract.
          if (!state)
            throw new Error('Cannot record usage outside an active rule job.')

          const usageRecord = {
            ...record,
            ruleId: record.ruleId ?? enabledRule.id,
          }

          state.bucket.usage.push(usageRecord)
          try {
            options.progress?.onUsage?.({ job: state.job, record: usageRecord })
          }
          catch (cause) {
            if (!state.reporterFailed) {
              state.reporterCause = cause
              state.reporterFailed = true
            }
            throw cause
          }
        },
      },
      model: async (selector) => {
        const request = options.options.modelOverride ?? (typeof selector === 'string' ? selector : undefined)
        const requirement = mergeModelRequirement(
          enabledRule.rule.model,
          typeof selector === 'string' ? undefined : selector,
        )
        const resolvedModel = resolveModel(options.setupConfig, {
          request,
          requirement,
          ruleId: enabledRule.id,
        })

        const state = executionState.getStore()

        if (state) {
          state.currentModel = toDiagnosticModel(resolvedModel, request)
        }

        return resolvedModel
      },
      options: enabledRule.options,
      outputLanguage: options.options.outputLanguage,
      report: (descriptor) => {
        const state = executionState.getStore()
        // TODO: (planning-observations) Create-time diagnostics and usage are rejected because they have no rule-job order; revisit only with an owner-approved planning evidence contract.
        if (!state)
          throw new Error('Cannot report a diagnostic outside an active rule job.')

        const filePath = descriptor.filePath ?? state.activeFilePath

        if (!filePath) {
          throw new Error(`Diagnostic for rule "${enabledRule.id}" is missing filePath.`)
        }

        const diagnosticModel = state.currentModel ? { ...state.currentModel } : undefined

        state.currentModel = undefined

        const diagnostic = {
          evidence: descriptor.evidence,
          filePath,
          loc: descriptor.loc,
          message: descriptor.message,
          model: diagnosticModel,
          ruleId: enabledRule.id,
          severity: enabledRule.severity,
        } satisfies Diagnostic

        state.bucket.diagnostics.push(diagnostic)
        try {
          options.progress?.onDiagnostic?.({ diagnostic, job: state.job })
        }
        catch (cause) {
          if (!state.reporterFailed) {
            state.reporterCause = cause
            state.reporterFailed = true
          }
          throw cause
        }
      },
      settings: options.effectiveSettings,
      get signal() {
        return executionState.getStore()?.signal
      },
      src: options.src,
    }

    return {
      cacheable: enabledRule.rule.cache !== false,
      enabledRule,
      executionState,
      handlers: enabledRule.rule.create(context),
      ruleHash: stableHash({
        cache: enabledRule.rule.cache ?? true,
        cacheKey: enabledRule.rule.cacheKey,
        create: String(enabledRule.rule.create),
        id: enabledRule.id,
        localId: enabledRule.localId,
        model: enabledRule.rule.model,
        options: enabledRule.options,
        severity: enabledRule.severity,
      }),
    }
  })
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

function mergeCapabilities(
  base: string[] | undefined,
  extra: string[] | undefined,
): string[] | undefined {
  if (!base && !extra) {
    return undefined
  }

  return [...new Set([...(base ?? []), ...(extra ?? [])])]
}

function mergeMinContextWindow(
  base: number | undefined,
  extra: number | undefined,
): number | undefined {
  if (base === undefined) {
    return extra
  }

  if (extra === undefined) {
    return base
  }

  return Math.max(base, extra)
}

function mergeModelRequirement(
  base: ModelRequirement | undefined,
  extra: ModelRequirement | undefined,
): ModelRequirement | undefined {
  if (!base && !extra) {
    return undefined
  }

  const capabilities = mergeCapabilities(base?.capabilities, extra?.capabilities)
  const params = {
    ...(base?.params ?? {}),
    ...(extra?.params ?? {}),
  }

  return {
    capabilities,
    minContextWindow: mergeMinContextWindow(
      base?.minContextWindow,
      extra?.minContextWindow,
    ),
    params: Object.keys(params).length > 0 ? params : undefined,
    size: extra?.size ?? base?.size,
  }
}

async function reconcileCache(
  filePlans: PreparedFileExecutionPlan[],
  cacheContext: CacheRunContext,
): Promise<void> {
  try {
    for (const filePlan of filePlans) {
      const file = filePlan.preparedFile.file
      const normalizedPath = normalizeCachePath(cacheContext.cwd, file.path)
      const entries = [...(cacheContext.fileEntryKeys.get(normalizedPath) ?? [])]

      cacheContext.store.markFile(file.path, hashText(file.text), entries)
    }

    await cacheContext.store.reconcile()
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
    (outcome.state === 'cached' ? cached : live).push(...outcome.bucket.usage)
  }

  return {
    ...usageTotals(live),
    ...(cached.length > 0 ? { cached: usageTotals(cached) } : {}),
  }
}

function toDiagnosticModel(
  model: ResolvedModel,
  request: string | undefined,
): NonNullable<Diagnostic['model']> {
  return {
    providerId: model.provider.id,
    requested: request,
    resolvedId: model.id,
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
