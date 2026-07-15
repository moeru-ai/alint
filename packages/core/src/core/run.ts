import type { AgentAdapter } from '../agent/types'
import type { SetupConfig } from '../config/types'
import type { DirectoryTarget, RuleContext } from '../dsl/types'
import type { ModelRequirement, ResolvedModel } from '../models/types'
import type { ExecutionProjection } from './execution/projection'
import type { RuleExecutionOutcome } from './execution/types'
import type { PreparedDirectory } from './targets/directory'
import type { CacheRunContext, PreparedFile, PreparedFileExecutionPlan, RuleRuntime, RuleRuntimeState, TargetExecutionPlan } from './targets/types'
import type { AlintRunFailure, Diagnostic, ProgressPlanRef, RunOptions, RunResult } from './types'

import { AsyncLocalStorage } from 'node:async_hooks'
import { cwd as processCwd } from 'node:process'

import { errorMessageFrom } from '@moeru/std/error'
import { resolve } from 'pathe'

import { combineAbortSignals } from '../agent'
import { withAgentRetry } from '../agent/retry'
import { resolveConfigForDirectory, resolveConfigForFile, resolveConfigForProject } from '../config/config-array'
import { buildRuleRegistry } from '../dsl/registry'
import { resolveModel } from '../models/resolve'
import { createCacheStore, hashText, normalizeCachePath, normalizeRunnerCacheConfig, stableHash } from './cache'
import { executeRuleExecutionJob, resolveRuleExecutionTimeout } from './execution/envelope'
import { selectTerminalFailure } from './execution/failure'
import { createRuleExecutionJobs } from './execution/jobs'
import { RunProgress } from './execution/progress'
import { createExecutionProjection } from './execution/projection'
import { runWithConcurrency } from './execution/scheduler'
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

export class AlintProgressError extends Error {
  readonly failures: AlintRunFailure[]
  readonly result: RunResult

  constructor(message: string, result: RunResult, failures: AlintRunFailure[], cause?: unknown) {
    super(message, { cause })
    this.name = 'AlintProgressError'
    this.failures = failures
    this.result = result
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
  const projection = createExecutionProjection()
  let progress: RunProgress | undefined
  const currentProgress = (): RunProgress => {
    if (!progress)
      throw new Error('Rule progress is unavailable before execution planning completes.')
    return progress
  }
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
      progress: currentProgress,
      projection,
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
        progress: currentProgress,
        projection,
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
        progress: currentProgress,
        projection,
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
  const activePlans = allPlans.filter(plan => plan.targets.length > 0)
  const jobs = createRuleExecutionJobs(allPlans)
  progress = new RunProgress(options.progress, jobs, clock)
  const runStartedAt = clock()
  let outcomes: RuleExecutionOutcome[] = []
  const settledOutcomes = new Array<RuleExecutionOutcome | undefined>(jobs.length)
  let infrastructureFailed = false
  let infrastructureError: unknown

  progress.emit('onRunStart', {
    execution: progress.execution,
    plans: activePlans.map(plan => toProgressPlanRef(plan, allPlans.length)),
    rulesTotal: countEnabledRuleIds(files, directories, projectRuleRuntimes),
    startedAt: runStartedAt,
  })

  try {
    const tasks = jobs.map((job, index) => async (): Promise<RuleExecutionOutcome> => {
      const observation = projection.register(job)
      if (options.signal?.aborted) {
        progress.cancelJob(job)
        const outcome: RuleExecutionOutcome = { bucket: observation.bucket, cache: 'miss', job, state: 'cancelled' }
        settledOutcomes[index] = outcome
        return outcome
      }

      progress.startJob(job)
      try {
        const outcome = await executeRuleExecutionJob(job, {
          cache: cacheContext,
          cacheOnly: options.cacheOnly,
          clock,
          observation,
          progress,
          runSignal: options.signal,
          timeoutMs,
        })
        progress.endJob(outcome)
        settledOutcomes[index] = outcome
        return outcome
      }
      catch (error) {
        progress.interruptJob(job)
        throw error
      }
    })
    outcomes = await runWithConcurrency(tasks, concurrency)
  }
  catch (error) {
    infrastructureFailed = true
    infrastructureError = error
    progress.cancelQueuedJobs()
    outcomes = settledOutcomes.filter((outcome): outcome is RuleExecutionOutcome => outcome != null)
  }
  finally {
    // cacheOnly runs are strictly read-only: reconciling a partial cache snapshot could
    // discard entries for the jobs deliberately skipped by this run.
    if (!options.cacheOnly)
      await reconcileCache(filePlans, cacheContext)
  }

  outcomes.sort((left, right) => left.job.path.job.index - right.job.path.job.index)
  const failedOutcomes = outcomes.filter(
    (outcome): outcome is Extract<RuleExecutionOutcome, { state: 'failed' }> => outcome.state === 'failed',
  )
  const failures = failedOutcomes.map(outcome => outcome.failure)
  const result: RunResult = {
    diagnostics: projection.diagnostics(),
    execution: progress.execution,
    usage: projection.usage(),
  }

  progress.emit('onRunEnd', {
    diagnostics: result.diagnostics,
    endedAt: clock(),
    execution: result.execution,
    startedAt: runStartedAt,
    usage: result.usage,
  })

  const terminalFailure = selectTerminalFailure({
    cancellationCause: options.signal?.reason,
    cancelled: options.signal?.aborted ?? false,
    failedOutcomeCauses: failedOutcomes.map(outcome => outcome.cause),
    failures,
    infrastructureCause: infrastructureError,
    infrastructureFailed,
    progressCause: progress.error,
    progressFailed: progress.failed,
  })
  if (terminalFailure?.kind === 'progress')
    throw new AlintProgressError('Progress reporting failed.', result, terminalFailure.failures, terminalFailure.cause)
  if (terminalFailure?.kind === 'cancelled')
    throw new AlintAbortError(result, { cause: terminalFailure.cause })
  if (terminalFailure?.kind === 'infrastructure') {
    throw new AlintRunError(errorMessageFrom(terminalFailure.cause) ?? String(terminalFailure.cause), result, {
      cause: terminalFailure.cause,
      failures: terminalFailure.failures,
    })
  }
  if (terminalFailure?.kind === 'rules') {
    throw new AlintRunError(`${terminalFailure.failures.length} rule execution${terminalFailure.failures.length === 1 ? '' : 's'} failed.`, result, {
      cause: new AggregateError(terminalFailure.causes, 'Rule execution failures.'),
      failures: terminalFailure.failures,
    })
  }

  return result
}

function countEnabledRuleIds(
  files: PreparedFile[],
  directories: PreparedDirectory[],
  projectRuleRuntimes: RuleRuntime[],
): number {
  const ids = new Set<string>()

  for (const file of files) {
    for (const runtime of file.ruleRuntimes) {
      ids.add(runtime.enabledRule.id)
    }
  }

  for (const directory of directories) {
    for (const runtime of directory.ruleRuntimes) {
      ids.add(runtime.enabledRule.id)
    }
  }

  for (const runtime of projectRuleRuntimes) {
    ids.add(runtime.enabledRule.id)
  }

  return ids.size
}

function createRuleRuntimes(options: {
  cwd: string
  effectiveAgent: AgentAdapter | undefined
  effectiveSettings: Record<string, unknown>
  options: RunOptions
  progress: () => Pick<RunProgress, 'emit'>
  projection: ExecutionProjection
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
    const context: RuleContext = {
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

          const payload = {
            path: state.progressPath,
            record: usageRecord,
            total: options.projection.usage(),
          }
          options.progress().emit('onUsage', payload)
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
        const payload = {
          diagnostic,
          diagnostics: options.projection.diagnostics(),
          path: state.progressPath,
        }
        options.progress().emit('onDiagnostic', payload)
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
        severity: enabledRule.severity,
      }),
    }
  })
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

function toProgressPlanRef(plan: TargetExecutionPlan, total: number): ProgressPlanRef {
  return {
    id: plan.id,
    index: plan.index,
    kind: plan.kind,
    path: plan.path,
    planned: plan.planned,
    total,
  }
}
