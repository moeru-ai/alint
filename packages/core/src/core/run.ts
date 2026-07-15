import type { AgentAdapter } from '../agent/types'
import type { SetupConfig } from '../config/types'
import type { DirectoryTarget, RuleContext } from '../dsl/types'
import type { ModelRequirement, ResolvedModel } from '../models/types'
import type { PreparedDirectory } from './targets/directory'
import type { CacheRunContext, PreparedFile, PreparedFileExecutionPlan, RuleEndCounters, RuleRuntime, RuleRuntimeState, TargetExecutionPlan, UsageAccumulator } from './targets/types'
import type { AlintRunFailure, Diagnostic, InferenceUsageRecord, RunOptions, RunResult, RunUsage } from './types'

import { AsyncLocalStorage } from 'node:async_hooks'
import { cwd as processCwd } from 'node:process'

import { errorCauseFrom, errorMessageFrom } from '@moeru/std/error'
import { resolve } from 'pathe'

import { withAgentRetry } from '../agent/retry'
import { resolveConfigForDirectory, resolveConfigForFile, resolveConfigForProject } from '../config/config-array'
import { buildRuleRegistry } from '../dsl/registry'
import { resolveModel } from '../models/resolve'
import { createCacheStore, hashText, normalizeCachePath, normalizeRunnerCacheConfig, stableHash } from './cache'
import { createBuiltInLanguageRegistry, registerLanguage, resolveLanguage } from './languages'
import { createSourceRuntime } from './source/runtime'
import { createDirectoryExecutionPlans } from './targets/directory'
import { AlintRuleExecutionError, executeTargetPlans } from './targets/execution'
import { createProjectExecutionPlan } from './targets/project'
import { createSourceExecutionPlans } from './targets/source'

export class AlintRunError extends Error {
  readonly failure?: AlintRunFailure
  readonly result: RunResult

  constructor(message: string, result: RunResult, options: { cause?: unknown, failure?: AlintRunFailure } = {}) {
    super(message, { cause: options.cause })
    this.name = 'AlintRunError'
    this.failure = options.failure
    this.result = result
  }
}

/**
 * Thrown when {@link RunOptions.signal} aborts a run.
 *
 * Extends {@link AlintRunError} so existing handlers still receive the partial `result`, while
 * callers that treat cancellation differently from failure can test for this type.
 */
export class AlintAbortError extends AlintRunError {
  constructor(result: RunResult, options: { cause?: unknown } = {}) {
    super('alint run was aborted', result, { cause: options.cause })
    this.name = 'AlintAbortError'
  }
}

export async function runAlint(options: RunOptions = {}): Promise<RunResult> {
  const cwd = options.cwd ?? processCwd()
  const config = options.config ?? []
  const setupConfig: SetupConfig = options.setupConfig ?? { providers: [], version: 1 }
  const clock = Date.now
  const diagnostics: Diagnostic[] = []

  const usage = createUsageAccumulator()
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
      diagnostics,
      effectiveAgent: effectiveConfig.agent,
      effectiveSettings: effectiveConfig.settings,
      options,
      registry,
      setupConfig,
      src,
      usage,
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
        diagnostics,
        effectiveAgent: effectiveConfig.agent,
        effectiveSettings: effectiveConfig.settings,
        options,
        registry,
        setupConfig,
        src,
        usage,
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
        diagnostics,
        effectiveAgent: projectConfig.agent,
        effectiveSettings: projectConfig.settings,
        options,
        registry: buildRuleRegistry(projectConfig),
        setupConfig,
        src,
        usage,
      })
  let planned = 0
  const counters = createRuleEndCounters()
  let filePlans: PreparedFileExecutionPlan[] = []
  let directoryPlans: TargetExecutionPlan[] = []
  let projectPlan: TargetExecutionPlan | undefined
  let runStartedAt: number | undefined
  let runError: unknown

  try {
    // Bail before planning so an already-cancelled caller never reaches a rule. Reading and
    // extracting the files above is local work that costs no tokens, so it is not worth a
    // second abort check earlier.
    options.signal?.throwIfAborted()

    filePlans = createSourceExecutionPlans(files, cwd)
    directoryPlans = createDirectoryExecutionPlans(directories, filePlans.length)
    projectPlan = resolvedProjectConfig.ignored
      ? undefined
      : createProjectExecutionPlan({
          configHash: stableHash({
            settings: projectConfig.settings,
          }),
          files,
          root: cwd,
          ruleRuntimes: projectRuleRuntimes,
        })

    const activeDirectoryPlans = directoryPlans
      .filter(plan => plan.targets.length > 0)
      .map((plan, directoryOffset) => ({
        ...plan,
        fileIndex: filePlans.length + directoryOffset + 1,
      }))

    const inputsTotal = files.length + activeDirectoryPlans.length
    planned = calculatePlannedExecutions([...filePlans, ...directoryPlans]) + (projectPlan?.planned ?? 0)
    runStartedAt = clock()

    options.progress?.onRunStart?.({
      files: [...filePlans, ...activeDirectoryPlans].map(plan => toProgressFilePath(plan, inputsTotal)),
      filesTotal: inputsTotal,
      planned,
      rulesTotal: countEnabledRuleIds(files, directories, projectRuleRuntimes),
      startedAt: runStartedAt,
    })

    await runConcurrently(
      filePlans.filter(filePlan => filePlan.targets.length > 0),
      resolveFileConcurrency(options.runner?.fileConcurrency),
      filePlan => executeTargetPlans({
        cache: cacheContext,
        cacheOnly: options.cacheOnly,
        clock,
        counters,
        diagnostics,
        filesTotal: inputsTotal,
        plans: [filePlan],
        progress: options.progress,
        signal: options.signal,
        usage,
      }),
    )

    await runConcurrently(
      activeDirectoryPlans,
      resolveFileConcurrency(options.runner?.fileConcurrency),
      directoryPlan => executeTargetPlans({
        cache: cacheContext,
        cacheOnly: options.cacheOnly,
        clock,
        counters,
        diagnostics,
        filesTotal: inputsTotal,
        plans: [directoryPlan],
        progress: options.progress,
        signal: options.signal,
        usage,
      }),
    )

    if (projectPlan) {
      await executeTargetPlans({
        cache: cacheContext,
        cacheOnly: options.cacheOnly,
        clock,
        counters,
        diagnostics,
        filesTotal: inputsTotal,
        plans: [projectPlan],
        progress: options.progress,
        signal: options.signal,
        usage,
      })
    }
  }
  catch (error) {
    runError = error
  }
  finally {
    // cacheOnly runs are strictly read-only.
    //
    // `reconcileCache` rewrites the whole cache file from the snapshot loaded at run start,
    // so any long-lived reader (an editor session doing a pass per file open) would race a
    // concurrent writer and rename its stale snapshot over results that writer just paid
    // model tokens for.
    //
    // Staying read-only also avoids `markFile` narrowing each file's entry list to only the
    // keys this run touched: skipped rules never call `rememberCacheEntry`, so reconciling a
    // cacheOnly run would drop the keys of every rule it declined to execute.
    if (!options.cacheOnly) {
      await reconcileCache(filePlans, cacheContext)
    }

    try {
      options.progress?.onRunEnd?.({
        ...counters.snapshot(planned),
        diagnostics,
        endedAt: clock(),
        startedAt: runStartedAt ?? clock(),
        usage: usage.toJSON(),
      })
    }
    catch (error) {
      runError ??= error
    }
  }

  const result = {
    diagnostics,
    execution: counters.snapshot(planned),
    usage: usage.toJSON(),
  }

  if (runError) {
    // Cancellation surfaces as its own type: the run did not fail, it was called off, and the
    // rules that finished before the abort still contributed diagnostics and cache entries.
    if (options.signal?.aborted) {
      throw new AlintAbortError(result, { cause: runError })
    }

    throw createAlintRunError(runError, result)
  }

  return result
}

function addTokenCount(base: number, value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? base + value : base
}

function calculatePlannedExecutions(
  filePlans: TargetExecutionPlan[],
): number {
  return filePlans.reduce((total, filePlan) => total + filePlan.planned, 0)
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

function createAlintRunError(error: unknown, result: RunResult): AlintRunError {
  if (error instanceof AlintRunError) {
    return error
  }

  if (error instanceof AlintRuleExecutionError) {
    return new AlintRunError(error.message, result, {
      cause: errorCauseFrom(error),
      failure: error.failure,
    })
  }

  return new AlintRunError(errorMessageFrom(error) ?? String(error), result, {
    cause: error,
  })
}

function createRuleEndCounters(): RuleEndCounters {
  let cached = 0
  let completed = 0
  let errored = 0
  let skipped = 0

  return {
    cache() {
      cached += 1
    },
    complete() {
      completed += 1
    },
    error() {
      errored += 1
    },
    skip() {
      skipped += 1
    },
    snapshot(planned: number) {
      return {
        cached,
        completed,
        errored,
        planned,
        skipped,
      }
    },
  }
}

function createRuleRuntimes(options: {
  cwd: string
  diagnostics: Diagnostic[]
  effectiveAgent: AgentAdapter | undefined
  effectiveSettings: Record<string, unknown>
  options: RunOptions
  registry: ReturnType<typeof buildRuleRegistry>
  setupConfig: SetupConfig
  src: ReturnType<typeof createSourceRuntime>
  usage: UsageAccumulator
}): RuleRuntime[] {
  const agent = options.effectiveAgent
    ? withAgentRetry(options.effectiveAgent, options.options.runner?.agentRetries)
    : undefined

  return options.registry.enabledRules.map((enabledRule) => {
    const executionState = new AsyncLocalStorage<RuleRuntimeState>()
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
          const usageRecord = options.usage.record({
            ...record,
            ruleId: record.ruleId ?? enabledRule.id,
          })
          const state = executionState.getStore()

          state?.cacheUsage?.push(usageRecord)

          options.options.progress?.onUsage?.({
            path: state?.progressPath,
            record: usageRecord,
            total: options.usage.toJSON(),
          })
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
        const filePath = descriptor.filePath ?? state?.activeFilePath

        if (!filePath) {
          throw new Error(`Diagnostic for rule "${enabledRule.id}" is missing filePath.`)
        }

        const diagnosticModel = state?.currentModel ? { ...state.currentModel } : undefined

        if (state) {
          state.currentModel = undefined
        }

        const diagnostic = {
          evidence: descriptor.evidence,
          filePath,
          loc: descriptor.loc,
          message: descriptor.message,
          model: diagnosticModel,
          ruleId: enabledRule.id,
          severity: enabledRule.severity,
        } satisfies Diagnostic

        options.diagnostics.push(diagnostic)
        state?.cacheDiagnostics?.push(diagnostic)
        options.options.progress?.onDiagnostic?.({
          diagnostic,
          diagnostics: [...options.diagnostics],
          path: state?.progressPath,
        })
      },
      settings: options.effectiveSettings,
      signal: options.options.signal,
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

function createUsageAccumulator(): UsageAccumulator {
  const live = createUsageTotals()
  const cached = createUsageTotals()

  return {
    record(record: InferenceUsageRecord): InferenceUsageRecord {
      return live.record(record)
    },
    recordCached(record: InferenceUsageRecord): InferenceUsageRecord {
      return cached.record(record)
    },
    toJSON(): RunUsage {
      const cachedUsage = cached.toJSON()

      return {
        ...live.toJSON(),
        ...(cachedUsage.records.length > 0 ? { cached: cachedUsage } : {}),
      }
    },
  }
}

function createUsageTotals() {
  const records: InferenceUsageRecord[] = []
  let inputTokens = 0
  let outputTokens = 0
  let totalTokens = 0

  return {
    record(record: InferenceUsageRecord): InferenceUsageRecord {
      records.push(record)
      inputTokens = addTokenCount(inputTokens, record.inputTokens)
      outputTokens = addTokenCount(outputTokens, record.outputTokens)
      totalTokens = addTokenCount(totalTokens, record.totalTokens)
      return record
    },
    toJSON() {
      return {
        inputTokens,
        outputTokens,
        records,
        totalTokens,
      }
    },
  }
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

function resolveFileConcurrency(fileConcurrency: number | undefined): number {
  return fileConcurrency ?? 1
}

async function runConcurrently<T>(
  items: T[],
  concurrency: number,
  runItem: (item: T) => Promise<void>,
): Promise<void> {
  let firstError: unknown
  let nextIndex = 0
  const workerCount = Math.min(Math.max(concurrency, 1), items.length)

  async function runWorker(): Promise<void> {
    while (firstError === undefined) {
      const currentIndex = nextIndex
      nextIndex += 1

      if (currentIndex >= items.length) {
        return
      }

      try {
        await runItem(items[currentIndex]!)
      }
      catch (error) {
        firstError ??= error
        return
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()))

  if (firstError !== undefined) {
    throw firstError
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

function toProgressFilePath(filePlan: TargetExecutionPlan, filesTotal: number) {
  return {
    index: filePlan.fileIndex,
    path: filePlan.path,
    planned: filePlan.planned,
    total: filesTotal,
  }
}
