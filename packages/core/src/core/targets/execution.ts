import type { CacheEntry } from '../cache'
import type { AlintRunFailure, Diagnostic, InferenceUsageRecord, ProgressPath, ProgressReporter } from '../types'
import type { CacheRunContext, ExecutionPlanEntry, ExecutionTarget, RuleEndCounters, RuleTargetExecution, TargetExecutionPlan, UsageAccumulator } from './types'

import { errorMessageFrom } from '@moeru/std/error'

import packageJson from '../../../package.json'

import { createCacheKey, normalizeCachePath, stableHash } from '../cache'

export interface ExecuteTargetPlansOptions {
  cache: CacheRunContext
  clock: () => number
  counters: RuleEndCounters
  diagnostics: Diagnostic[]
  filesTotal: number
  plans: TargetExecutionPlan[]
  progress?: ProgressReporter
  usage: UsageAccumulator
}

export class AlintRuleExecutionError extends Error {
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

export async function executeTargetPlans(options: ExecuteTargetPlansOptions): Promise<void> {
  for (const plan of options.plans) {
    await executeTargetPlan(plan, options)
  }
}

function createExecutionCacheKey(
  runtime: RuleTargetExecution['runtime'],
  target: ExecutionTarget,
  path: ProgressPath,
  cache: CacheRunContext,
): string | undefined {
  if (!cache.enabled || !runtime.cacheable || target.cacheFilePaths.length === 0) {
    return undefined
  }

  return createCacheKey({
    alintVersion: packageJson.version,
    configHash: target.configHash,
    filePath: normalizeCachePath(cache.cwd, path.file.path),
    modelHash: cache.modelHash,
    ruleHash: runtime.ruleHash,
    schemaVersion: 1,
    targetHash: createTargetHash(target),
    targetIdentity: target.identity,
    targetKind: target.kind,
  })
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

function emitErroredRuleEnd(
  progress: ProgressReporter | undefined,
  clock: () => number,
  path: ProgressPath,
  startedAt: number,
  cache: 'hit' | 'miss',
): void {
  try {
    progress?.onRuleEnd?.({
      cache,
      endedAt: clock(),
      path,
      startedAt,
      state: 'errored',
    })
  }
  catch {
    // Preserve the original handler or cache replay failure.
  }
}

async function executeRule(
  execution: RuleTargetExecution,
  path: ProgressPath,
  target: ExecutionTarget,
  options: ExecuteTargetPlansOptions,
): Promise<void> {
  const { cache, clock, counters, diagnostics, progress, usage } = options
  const startedAt = clock()
  const cacheKey = createExecutionCacheKey(execution.runtime, target, path, cache)
  const cachedEntry = cacheKey ? cache.store.get(cacheKey) : undefined

  progress?.onRuleStart?.({
    path,
    startedAt,
  })

  if (cacheKey && cachedEntry) {
    rememberCacheEntry(cache, target.cacheFilePaths, cacheKey)

    try {
      replayCachedEntry(cachedEntry, path, diagnostics, usage, progress)
    }
    catch (error) {
      counters.error()
      emitErroredRuleEnd(progress, clock, path, startedAt, 'hit')
      throw new AlintRuleExecutionError(error, path)
    }

    counters.cache()
    progress?.onRuleEnd?.({
      cache: 'hit',
      endedAt: clock(),
      path,
      startedAt,
      state: 'completed',
    })
    return
  }

  let handlerError: unknown
  let handlerFailed = false
  const cacheDiagnostics: Diagnostic[] | undefined = cacheKey ? [] : undefined
  const cacheUsage: InferenceUsageRecord[] | undefined = cacheKey ? [] : undefined

  try {
    await execution.runtime.executionState.run({
      activeFilePath: target.activeFilePath,
      cacheDiagnostics,
      cacheUsage,
      progressPath: path,
    }, execution.run)
  }
  catch (error) {
    handlerError = error
    handlerFailed = true
  }

  if (handlerFailed) {
    counters.error()
    emitErroredRuleEnd(progress, clock, path, startedAt, 'miss')
    throw new AlintRuleExecutionError(handlerError, path)
  }

  if (cacheKey) {
    cache.store.set(cacheKey, {
      diagnostics: cacheDiagnostics ?? [],
      filePath: normalizeCachePath(cache.cwd, path.file.path),
      fingerprint: {
        alintVersion: packageJson.version,
        configHash: target.configHash,
        modelHash: cache.modelHash,
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
    rememberCacheEntry(cache, target.cacheFilePaths, cacheKey)
  }

  counters.complete()
  progress?.onRuleEnd?.({
    cache: 'miss',
    endedAt: clock(),
    path,
    startedAt,
    state: 'completed',
  })
}

async function executeTargetPlan(
  plan: TargetExecutionPlan,
  options: ExecuteTargetPlansOptions,
): Promise<void> {
  const { clock, filesTotal, progress } = options
  const fileStartedAt = clock()
  const fileProgress = {
    index: plan.fileIndex,
    path: plan.path,
    planned: plan.planned,
    total: filesTotal,
  }

  if (plan.emitFileProgress) {
    progress?.onFileStart?.({
      file: fileProgress,
      startedAt: fileStartedAt,
    })
  }

  let planError: unknown
  let planFailed = false

  try {
    for (const [targetOffset, target] of plan.targets.entries()) {
      const targetPath = createProgressPath(
        plan.path,
        target.executions[0]?.runtime.enabledRule.id ?? '',
        {
          fileIndex: plan.fileIndex,
          filePlanned: plan.planned,
          fileTotal: filesTotal,
          ruleIndex: 1,
          ruleTotal: target.executions.length,
          targetIndex: targetOffset + 1,
          targetKind: target.kind,
          targetName: target.name,
          targetTotal: plan.targets.length,
        },
      )
      const targetStartedAt = clock()

      progress?.onTargetStart?.({
        path: targetPath,
        startedAt: targetStartedAt,
      })

      let targetError: unknown
      let targetFailed = false

      try {
        for (const [executionOffset, execution] of target.executions.entries()) {
          const progressPath = createProgressPath(
            plan.path,
            execution.runtime.enabledRule.id,
            {
              fileIndex: plan.fileIndex,
              filePlanned: plan.planned,
              fileTotal: filesTotal,
              ruleIndex: executionOffset + 1,
              ruleTotal: target.executions.length,
              targetIndex: targetOffset + 1,
              targetKind: target.kind,
              targetName: target.name,
              targetTotal: plan.targets.length,
            },
          )

          await executeRule(execution, progressPath, target, options)
        }
      }
      catch (error) {
        targetError = error
        targetFailed = true
      }

      try {
        progress?.onTargetEnd?.({
          endedAt: clock(),
          path: targetPath,
          startedAt: targetStartedAt,
        })
      }
      catch (error) {
        if (!targetFailed) {
          targetError = error
          targetFailed = true
        }
      }

      if (targetFailed) {
        throw targetError
      }
    }
  }
  catch (error) {
    planError = error
    planFailed = true
  }

  if (plan.emitFileProgress) {
    try {
      progress?.onFileEnd?.({
        endedAt: clock(),
        file: fileProgress,
        startedAt: fileStartedAt,
      })
    }
    catch (error) {
      if (!planFailed) {
        planError = error
        planFailed = true
      }
    }
  }

  if (planFailed) {
    throw planError
  }
}

function rememberCacheEntry(
  cache: CacheRunContext,
  filePaths: string[],
  cacheKey: string,
): void {
  for (const filePath of filePaths) {
    const normalizedPath = normalizeCachePath(cache.cwd, filePath)
    const entries = cache.fileEntryKeys.get(normalizedPath) ?? new Set<string>()

    entries.add(cacheKey)
    cache.fileEntryKeys.set(normalizedPath, entries)
  }
}

function replayCachedEntry(
  entry: CacheEntry,
  path: ProgressPath,
  diagnostics: Diagnostic[],
  usage: UsageAccumulator,
  progress: ProgressReporter | undefined,
): void {
  for (const cachedDiagnostic of entry.diagnostics) {
    const diagnostic = { ...cachedDiagnostic, cached: true }

    diagnostics.push(diagnostic)
    progress?.onDiagnostic?.({
      diagnostic,
      diagnostics: [...diagnostics],
      path,
    })
  }

  for (const cachedUsage of entry.usage) {
    const record = usage.recordCached({ ...cachedUsage })

    progress?.onUsage?.({
      path,
      record,
      total: usage.toJSON(),
    })
  }
}
