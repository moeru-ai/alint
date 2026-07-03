import type { SetupConfig } from '../config/types'
import type { Awaitable, EnabledRule, RuleContext, RuleHandlers } from '../dsl/types'
import type { ModelRequirement, ResolvedModel } from '../models/types'
import type { CacheEntry, CacheStore } from './cache'
import type { SourceFile, SourceTarget } from './source/types'
import type { Diagnostic, InferenceUsageRecord, ProgressPath, ProgressTargetKind, RunOptions, RunResult, RunUsage } from './types'

import { AsyncLocalStorage } from 'node:async_hooks'
import { cwd as processCwd } from 'node:process'

import { errorCauseFrom, errorMessageFrom } from '@moeru/std/error'
import { resolve } from 'pathe'

import packageJson from '../../package.json'

import { resolveConfigForFile } from '../config/config-array'
import { buildRuleRegistry } from '../dsl/registry'
import { resolveModel } from '../models/resolve'
import {
  createCacheKey,
  createCacheStore,
  createTargetIdentityResolver,
  hashText,
  normalizeCachePath,
  normalizeRunnerCacheConfig,
  stableHash,
} from './cache'
import { createBuiltInLanguageRegistry, registerLanguage, resolveLanguage } from './languages'
import { createSourceRuntime } from './source/runtime'

export interface AlintRunFailure {
  filePath?: string
  message: string
  ruleId?: string
  target?: {
    kind: ProgressTargetKind
    name?: string
  }
}

interface CacheRunContext {
  cwd: string
  enabled: boolean
  fileEntryKeys: Map<string, Set<string>>
  modelHash: string
  store: CacheStore
}

interface ExecutionPlanEntry {
  fileIndex: number
  filePlanned: number
  fileTotal: number
  ruleIndex: number
  ruleTotal: number
  targetIndex: number
  targetKind: ProgressTargetKind
  targetName?: string
  targetTotal: number
}

interface ExecutionTarget {
  configHash: string
  executions: RuleTargetExecution[]
  identity: string
  kind: ProgressTargetKind
  language: string
  loc?: CacheEntry['target']['loc']
  metadata?: Record<string, unknown>
  name?: string
  origin?: SourceTarget['origin']
  range?: CacheEntry['target']['range']
  text: string
}

interface PreparedFile {
  configHash: string
  file: SourceFile
  ruleRuntimes: RuleRuntime[]
  targets: SourceTarget[]
}

interface PreparedFileExecutionPlan {
  fileIndex: number
  planned: number
  preparedFile: PreparedFile
  targets: ExecutionTarget[]
}

interface RuleRuntime {
  cacheable: boolean
  enabledRule: EnabledRule
  executionState: AsyncLocalStorage<RuleRuntimeState>
  handlers: RuleHandlers
  ruleHash: string
}

interface RuleRuntimeState {
  activeFilePath?: string
  cacheDiagnostics?: Diagnostic[]
  cacheUsage?: InferenceUsageRecord[]
  currentModel?: { providerId: string, requested?: string, resolvedId: string }
  progressPath?: ProgressPath
}

interface RuleTargetExecution {
  run: () => Awaitable<void>
  runtime: RuleRuntime
}

class AlintRuleExecutionError extends Error {
  readonly failure: AlintRunFailure

  constructor(error: unknown, path: ProgressPath) {
    const message = errorMessageFrom(error) ?? String(error)

    super(message, { cause: error })
    this.name = 'AlintRuleExecutionError'
    this.failure = {
      filePath: path.file.path,
      message,
      ruleId: path.rule.id,
      target: {
        kind: path.target.kind,
        name: path.target.name,
      },
    }
  }
}

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

export async function runAlint(options: RunOptions = {}): Promise<RunResult> {
  const cwd = options.cwd ?? processCwd()
  const config = options.config ?? []
  const setupConfig: SetupConfig = options.setupConfig ?? { providers: [], version: 1 }
  const clock = options.runner?.clock ?? Date.now
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
    modelHash: stableHash({ modelOverride: options.modelOverride, setupConfig }),
    store: cacheStore,
  }
  const files = (await Promise.all(
    (options.files ?? []).map(async (filePath): Promise<PreparedFile | undefined> => {
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

      const language = resolveLanguage(file, languageRegistry, {
        language: effectiveConfig.language,
      })
      const targets = await language.extract(file, {
        cwd,
        languageOptions: effectiveConfig.languageOptions,
        src,
      })
      const registry = buildRuleRegistry(effectiveConfig)
      const ruleRuntimes = createRuleRuntimes({
        cwd,
        diagnostics,
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
          rules: effectiveConfig.rules,
          settings: effectiveConfig.settings,
        }),
        file,
        ruleRuntimes,
        targets,
      }
    }),
  )).filter((file): file is PreparedFile => file !== undefined)
  let planned = 0
  const counters = createRuleEndCounters()
  const primaryError = createPrimaryErrorState()
  let filePlans: PreparedFileExecutionPlan[] = []
  let runStartedAt: number | undefined
  let runError: unknown

  try {
    filePlans = createPreparedFileExecutionPlans(files, cwd)
    planned = calculatePlannedExecutions(filePlans)
    runStartedAt = clock()

    options.progress?.onRunStart?.({
      files: filePlans.map(filePlan => toProgressFilePath(filePlan, files.length)),
      filesTotal: files.length,
      planned,
      rulesTotal: countEnabledRuleIds(files),
      startedAt: runStartedAt,
    })

    await runConcurrently(
      filePlans.filter(filePlan => filePlan.targets.length > 0),
      resolveFileConcurrency(options.runner?.fileConcurrency),
      filePlan => executeFilePlan(filePlan, files.length, clock, counters, diagnostics, usage, cacheContext, options),
    )
  }
  catch (error) {
    primaryError.set()
    runError = error
  }
  finally {
    await reconcileCache(filePlans, cacheContext)
    emitCleanupProgress(
      () => options.progress?.onRunEnd?.({
        ...counters.snapshot(planned),
        diagnostics,
        endedAt: clock(),
        startedAt: runStartedAt ?? clock(),
        usage: usage.toJSON(),
      }),
      primaryError,
    )
  }

  const result = {
    diagnostics,
    usage: usage.toJSON(),
  }

  if (runError) {
    throw createAlintRunError(runError, result)
  }

  return result
}

function addTokenCount(base: number, value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? base + value : base
}

function calculateFilePlanExecutions(filePlan: PreparedFileExecutionPlan): number {
  return filePlan.targets.reduce(
    (total, target) => total + target.executions.length,
    0,
  )
}

function calculatePlannedExecutions(
  filePlans: PreparedFileExecutionPlan[],
): number {
  return filePlans.reduce((total, filePlan) => total + filePlan.planned, 0)
}

function collectExecutionTargets(
  preparedFile: PreparedFile,
): ExecutionTarget[] {
  const targets: ExecutionTarget[] = []

  for (const sourceTarget of preparedFile.targets) {
    const executions = preparedFile.ruleRuntimes
      .map((runtime): RuleTargetExecution | undefined => {
        if (!runtime.handlers.onTarget) {
          return undefined
        }

        return {
          run: () => runtime.handlers.onTarget?.(sourceTarget),
          runtime,
        }
      })
      .filter((execution): execution is RuleTargetExecution => execution !== undefined)

    if (executions.length === 0) {
      continue
    }

    targets.push({
      configHash: preparedFile.configHash,
      executions,
      identity: sourceTarget.identity,
      kind: sourceTarget.kind,
      language: sourceTarget.language,
      loc: sourceTarget.loc,
      metadata: sourceTarget.metadata,
      name: sourceTarget.name,
      origin: sourceTarget.origin,
      range: sourceTarget.range,
      text: sourceTarget.text,
    })
  }

  return targets
}

function countEnabledRuleIds(files: PreparedFile[]): number {
  const ids = new Set<string>()

  for (const file of files) {
    for (const runtime of file.ruleRuntimes) {
      ids.add(runtime.enabledRule.id)
    }
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

function createExecutionCacheKey(
  runtime: RuleRuntime,
  target: ExecutionTarget,
  path: ProgressPath,
  cacheContext: CacheRunContext,
): string | undefined {
  if (!cacheContext.enabled || !runtime.cacheable) {
    return undefined
  }

  return createCacheKey({
    alintVersion: packageJson.version,
    configHash: target.configHash,
    filePath: normalizeCachePath(cacheContext.cwd, path.file.path),
    modelHash: cacheContext.modelHash,
    ruleHash: runtime.ruleHash,
    schemaVersion: 1,
    targetHash: createTargetHash(target),
    targetIdentity: target.identity,
    targetKind: target.kind,
  })
}

function createPreparedFileExecutionPlans(
  files: PreparedFile[],
  cwd: string,
): PreparedFileExecutionPlan[] {
  return files.map((preparedFile, fileOffset) => {
    const targets = collectExecutionTargets(preparedFile)
    const resolveTargetIdentity = createTargetIdentityResolver(
      targets.map(target => toTargetIdentityInput(cwd, preparedFile.file.path, target)),
    )

    for (const target of targets) {
      target.identity = resolveTargetIdentity(toTargetIdentityInput(cwd, preparedFile.file.path, target))
    }

    const filePlan: PreparedFileExecutionPlan = {
      fileIndex: fileOffset + 1,
      planned: 0,
      preparedFile,
      targets,
    }

    filePlan.planned = calculateFilePlanExecutions(filePlan)

    return filePlan
  })
}

function createPrimaryErrorState() {
  let hasError = false

  return {
    get hasError() {
      return hasError
    },
    set() {
      hasError = true
    },
  }
}

function createProgressPath(
  filePath: string,
  ruleId: string,
  entry: ExecutionPlanEntry,
): ProgressPath {
  return {
    file: {
      index: entry.fileIndex,
      path: filePath,
      planned: entry.filePlanned,
      total: entry.fileTotal,
    },
    rule: {
      id: ruleId,
      index: entry.ruleIndex,
      total: entry.ruleTotal,
    },
    target: {
      index: entry.targetIndex,
      kind: entry.targetKind,
      name: entry.targetName,
      total: entry.targetTotal,
    },
  }
}

function createRuleEndCounters() {
  let cached = 0
  let completed = 0
  let errored = 0

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
    snapshot(planned: number) {
      return {
        cached,
        completed,
        errored,
        planned,
      }
    },
  }
}

function createRuleRuntimes(options: {
  cwd: string
  diagnostics: Diagnostic[]
  effectiveSettings: Record<string, unknown>
  options: RunOptions
  registry: ReturnType<typeof buildRuleRegistry>
  setupConfig: SetupConfig
  src: ReturnType<typeof createSourceRuntime>
  usage: ReturnType<typeof createUsageAccumulator>
}): RuleRuntime[] {
  return options.registry.enabledRules.map((enabledRule) => {
    const executionState = new AsyncLocalStorage<RuleRuntimeState>()
    const context: RuleContext = {
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
      src: options.src,
    }

    return {
      cacheable: enabledRule.rule.cache !== false,
      enabledRule,
      executionState,
      handlers: enabledRule.rule.create(context),
      ruleHash: stableHash({
        cache: enabledRule.rule.cache ?? true,
        create: String(enabledRule.rule.create),
        id: enabledRule.id,
        localId: enabledRule.localId,
        model: enabledRule.rule.model,
        severity: enabledRule.severity,
      }),
    }
  })
}

function createTargetHash(target: ExecutionTarget): string {
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

function createUsageAccumulator() {
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
    toJSON(): RunUsage {
      return {
        inputTokens,
        outputTokens,
        records,
        totalTokens,
      }
    },
  }
}

function emitCleanupProgress(
  callback: () => void,
  primaryError: ReturnType<typeof createPrimaryErrorState>,
): void {
  try {
    callback()
  }
  catch (error) {
    if (!primaryError.hasError) {
      throw error
    }
  }
}

async function executeFilePlan(
  filePlan: PreparedFileExecutionPlan,
  filesTotal: number,
  clock: () => number,
  counters: ReturnType<typeof createRuleEndCounters>,
  diagnostics: Diagnostic[],
  usage: ReturnType<typeof createUsageAccumulator>,
  cacheContext: CacheRunContext,
  options: RunOptions,
): Promise<void> {
  const preparedFile = filePlan.preparedFile
  const fileStartedAt = clock()
  const fileProgress = {
    index: filePlan.fileIndex,
    path: preparedFile.file.path,
    planned: filePlan.planned,
    total: filesTotal,
  }

  options.progress?.onFileStart?.({
    file: fileProgress,
    startedAt: fileStartedAt,
  })

  const fileError = createPrimaryErrorState()

  try {
    for (const [targetOffset, target] of filePlan.targets.entries()) {
      const targetPath = createProgressPath(
        preparedFile.file.path,
        target.executions[0]?.runtime.enabledRule.id ?? '',
        {
          fileIndex: filePlan.fileIndex,
          filePlanned: filePlan.planned,
          fileTotal: filesTotal,
          ruleIndex: 1,
          ruleTotal: target.executions.length,
          targetIndex: targetOffset + 1,
          targetKind: target.kind,
          targetName: target.name,
          targetTotal: filePlan.targets.length,
        },
      )
      const targetError = createPrimaryErrorState()
      const targetStartedAt = clock()

      options.progress?.onTargetStart?.({
        path: targetPath,
        startedAt: targetStartedAt,
      })

      try {
        for (const [executionOffset, execution] of target.executions.entries()) {
          const progressPath = createProgressPath(
            preparedFile.file.path,
            execution.runtime.enabledRule.id,
            {
              fileIndex: filePlan.fileIndex,
              filePlanned: filePlan.planned,
              fileTotal: filesTotal,
              ruleIndex: executionOffset + 1,
              ruleTotal: target.executions.length,
              targetIndex: targetOffset + 1,
              targetKind: target.kind,
              targetName: target.name,
              targetTotal: filePlan.targets.length,
            },
          )

          await executeProgressTarget(
            execution,
            progressPath,
            target,
            clock,
            counters,
            diagnostics,
            usage,
            cacheContext,
            options,
          )
        }
      }
      catch (error) {
        targetError.set()
        throw error
      }
      finally {
        emitCleanupProgress(
          () => options.progress?.onTargetEnd?.({
            endedAt: clock(),
            path: targetPath,
            startedAt: targetStartedAt,
          }),
          targetError,
        )
      }
    }
  }
  catch (error) {
    fileError.set()
    throw error
  }
  finally {
    emitCleanupProgress(
      () => options.progress?.onFileEnd?.({
        endedAt: clock(),
        file: fileProgress,
        startedAt: fileStartedAt,
      }),
      fileError,
    )
  }
}

async function executeProgressTarget(
  execution: RuleTargetExecution,
  path: ProgressPath,
  target: ExecutionTarget,
  clock: () => number,
  counters: ReturnType<typeof createRuleEndCounters>,
  diagnostics: Diagnostic[],
  usage: ReturnType<typeof createUsageAccumulator>,
  cacheContext: CacheRunContext,
  options: RunOptions,
): Promise<void> {
  const startedAt = clock()
  const cacheKey = createExecutionCacheKey(execution.runtime, target, path, cacheContext)
  const cachedEntry = cacheKey && cacheContext.enabled && execution.runtime.cacheable
    ? cacheContext.store.get(cacheKey)
    : undefined

  options.progress?.onRuleStart?.({
    path,
    startedAt,
  })

  if (cacheKey && cachedEntry) {
    rememberFileCacheEntry(cacheContext, path.file.path, cacheKey)
    try {
      replayCachedEntry(cachedEntry, path, diagnostics, usage, options)
    }
    catch (error) {
      counters.error()

      try {
        options.progress?.onRuleEnd?.({
          cache: 'hit',
          endedAt: clock(),
          path,
          startedAt,
          state: 'errored',
        })
      }
      catch {
        // Preserve the original replay failure when error-progress callbacks also fail.
      }

      throw new AlintRuleExecutionError(error, path)
    }

    counters.cache()
    options.progress?.onRuleEnd?.({
      cache: 'hit',
      endedAt: clock(),
      path,
      startedAt,
      state: 'completed',
    })
    return
  }

  let handlerError: unknown
  let handlerSucceeded = false
  const cacheDiagnostics: Diagnostic[] | undefined = cacheKey ? [] : undefined
  const cacheUsage: InferenceUsageRecord[] | undefined = cacheKey ? [] : undefined

  try {
    await execution.runtime.executionState.run({
      activeFilePath: path.file.path,
      cacheDiagnostics,
      cacheUsage,
      progressPath: path,
    }, execution.run)
    handlerSucceeded = true
  }
  catch (error) {
    handlerError = error
  }

  if (handlerSucceeded) {
    if (cacheKey && cacheContext.enabled && execution.runtime.cacheable) {
      cacheContext.store.set(cacheKey, {
        diagnostics: cacheDiagnostics ?? [],
        filePath: normalizeCachePath(cacheContext.cwd, path.file.path),
        fingerprint: {
          alintVersion: packageJson.version,
          configHash: target.configHash,
          modelHash: cacheContext.modelHash,
          ruleHash: execution.runtime.ruleHash,
        },
        target: {
          hash: createTargetHash(target),
          identity: target.identity,
          kind: target.kind,
          loc: target.loc,
          name: target.name,
          range: target.range,
        },
        usage: cacheUsage ?? [],
      })
      rememberFileCacheEntry(cacheContext, path.file.path, cacheKey)
    }

    counters.complete()
    options.progress?.onRuleEnd?.({
      cache: 'miss',
      endedAt: clock(),
      path,
      startedAt,
      state: 'completed',
    })
    return
  }

  counters.error()

  try {
    options.progress?.onRuleEnd?.({
      cache: 'miss',
      endedAt: clock(),
      path,
      startedAt,
      state: 'errored',
    })
  }
  catch {
    // Preserve the original rule failure when error-progress callbacks also fail.
  }

  throw new AlintRuleExecutionError(handlerError, path)
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

function rememberFileCacheEntry(
  cacheContext: CacheRunContext,
  filePath: string,
  cacheKey: string,
): void {
  const normalizedPath = normalizeCachePath(cacheContext.cwd, filePath)
  const entries = cacheContext.fileEntryKeys.get(normalizedPath) ?? new Set<string>()

  entries.add(cacheKey)
  cacheContext.fileEntryKeys.set(normalizedPath, entries)
}

function replayCachedEntry(
  entry: CacheEntry,
  path: ProgressPath,
  diagnostics: Diagnostic[],
  usage: ReturnType<typeof createUsageAccumulator>,
  options: RunOptions,
): void {
  for (const cachedDiagnostic of entry.diagnostics) {
    const diagnostic = { ...cachedDiagnostic }

    diagnostics.push(diagnostic)
    options.progress?.onDiagnostic?.({
      diagnostic,
      diagnostics: [...diagnostics],
      path,
    })
  }

  for (const cachedUsage of entry.usage) {
    const record = usage.record({ ...cachedUsage })

    options.progress?.onUsage?.({
      path,
      record,
      total: usage.toJSON(),
    })
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

function toProgressFilePath(filePlan: PreparedFileExecutionPlan, filesTotal: number) {
  return {
    index: filePlan.fileIndex,
    path: filePlan.preparedFile.file.path,
    planned: filePlan.planned,
    total: filesTotal,
  }
}

function toTargetIdentityInput(
  cwd: string,
  filePath: string,
  target: ExecutionTarget,
) {
  return {
    filePath: target.kind === 'file' ? normalizeCachePath(cwd, filePath) : undefined,
    identity: target.identity,
    kind: target.kind,
    name: target.name,
    range: target.range,
  }
}
