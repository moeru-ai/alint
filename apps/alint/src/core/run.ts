import type { Awaitable, EnabledRule, RuleContext, RuleHandlers } from '../dsl/types'
import type { ModelRequirement, ResolvedModel } from '../models/types'
import type { JsSourceUnits } from './source/js'
import type { SourceFile } from './source/types'
import type { Diagnostic, InferenceUsageRecord, ProgressPath, ProgressTargetKind, RunOptions, RunResult, RunUsage } from './types'

import process from 'node:process'

import { AsyncLocalStorage } from 'node:async_hooks'

import { resolve } from 'pathe'

import { loadAlintConfig } from '../config/load-config'
import { emptySetupConfig } from '../config/setup-load'
import { buildRuleRegistry } from '../dsl/registry'
import { resolveModel } from '../models/resolve'
import { extractJsSourceUnits } from './source/js'
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
  executions: RuleTargetExecution[]
  kind: ProgressTargetKind
  name?: string
}

interface PreparedFile {
  file: SourceFile
  units: JsSourceUnits | undefined
}

interface PreparedFileExecutionPlan {
  fileIndex: number
  planned: number
  preparedFile: PreparedFile
  targets: ExecutionTarget[]
}

interface RuleRuntime {
  enabledRule: EnabledRule
  executionState: AsyncLocalStorage<RuleRuntimeState>
  handlers: RuleHandlers
}

interface RuleRuntimeState {
  activeFilePath?: string
  currentModel?: { providerId: string, requested?: string, resolvedId: string }
  progressPath?: ProgressPath
}

interface RuleTargetExecution {
  run: () => Awaitable<void>
  runtime: RuleRuntime
}

class AlintRuleExecutionError extends Error {
  readonly cause: unknown
  readonly failure: AlintRunFailure

  constructor(error: unknown, path: ProgressPath) {
    const message = toErrorMessage(error)

    super(message)
    this.name = 'AlintRuleExecutionError'
    this.cause = error
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
  readonly cause: unknown
  readonly failure?: AlintRunFailure
  readonly result: RunResult

  constructor(message: string, result: RunResult, options: { cause?: unknown, failure?: AlintRunFailure } = {}) {
    super(message)
    this.name = 'AlintRunError'
    this.cause = options.cause
    this.failure = options.failure
    this.result = result
  }
}

export async function runAlint(options: RunOptions = {}): Promise<RunResult> {
  const cwd = options.cwd ?? process.cwd()
  const config = options.config ?? await loadAlintConfig(cwd)
  const setupConfig = options.setupConfig ?? emptySetupConfig
  const clock = options.runner?.clock ?? Date.now
  const diagnostics: Diagnostic[] = []
  const usage = createUsageAccumulator()
  const registry = buildRuleRegistry(config)
  const src = createSourceRuntime()
  const files = await Promise.all(
    (options.files ?? []).map(async (filePath) => {
      const file = await src.readFile(resolve(cwd, filePath))
      const units = file.language === 'javascript' || file.language === 'typescript'
        ? extractJsSourceUnits(file)
        : undefined

      return {
        file,
        units,
      }
    }),
  )
  let planned = 0
  const counters = createRuleEndCounters()
  const primaryError = createPrimaryErrorState()
  let runStartedAt: number | undefined
  let runError: unknown

  try {
    const ruleRuntimes = registry.enabledRules.map((enabledRule) => {
      const executionState = new AsyncLocalStorage<RuleRuntimeState>()
      const context: RuleContext = {
        cwd,
        id: enabledRule.id,
        localId: enabledRule.localId,
        logger: {
          debug: () => {},
        },
        metering: {
          recordUsage: (record) => {
            const usageRecord = usage.record({
              ...record,
              ruleId: record.ruleId ?? enabledRule.id,
            })

            options.progress?.onUsage?.({
              path: executionState.getStore()?.progressPath,
              record: usageRecord,
              total: usage.toJSON(),
            })
          },
        },
        model: async (selector) => {
          const request = options.modelOverride ?? (typeof selector === 'string' ? selector : undefined)
          const requirement = mergeModelRequirement(
            enabledRule.rule.model,
            typeof selector === 'string' ? undefined : selector,
          )
          const resolvedModel = resolveModel(setupConfig, {
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

          diagnostics.push(diagnostic)
          options.progress?.onDiagnostic?.({
            diagnostic,
            diagnostics: [...diagnostics],
            path: state?.progressPath,
          })
        },
        scope: enabledRule.scope,
        src,
      }

      return {
        enabledRule,
        executionState,
        handlers: enabledRule.rule.create(context),
      }
    })

    const filePlans = createPreparedFileExecutionPlans(ruleRuntimes, files)
    planned = calculatePlannedExecutions(filePlans)
    runStartedAt = clock()

    options.progress?.onRunStart?.({
      files: filePlans.map(filePlan => toProgressFilePath(filePlan, files.length)),
      filesTotal: files.length,
      planned,
      rulesTotal: registry.enabledRules.length,
      startedAt: runStartedAt,
    })

    await runConcurrently(
      filePlans.filter(filePlan => filePlan.targets.length > 0),
      resolveFileConcurrency(options.runner?.fileConcurrency),
      filePlan => executeFilePlan(filePlan, files.length, clock, counters, options),
    )
  }
  catch (error) {
    primaryError.set()
    runError = error
  }
  finally {
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
  ruleRuntimes: RuleRuntime[],
  preparedFile: PreparedFile,
): ExecutionTarget[] {
  const targets: ExecutionTarget[] = []
  const fileExecutions = ruleRuntimes
    .map((runtime): RuleTargetExecution | undefined => {
      if (!runtime.handlers.onFile)
        return undefined

      return {
        run: () => runtime.handlers.onFile?.(preparedFile.file),
        runtime,
      }
    })
    .filter((execution): execution is RuleTargetExecution => execution !== undefined)

  if (fileExecutions.length > 0) {
    targets.push({
      executions: fileExecutions,
      kind: 'file',
    })
  }

  if (preparedFile.units) {
    for (const classNode of preparedFile.units.classes) {
      const executions = ruleRuntimes
        .map((runtime): RuleTargetExecution | undefined => {
          if (!runtime.handlers.onClass)
            return undefined

          return {
            run: () => runtime.handlers.onClass?.(classNode),
            runtime,
          }
        })
        .filter((execution): execution is RuleTargetExecution => execution !== undefined)

      if (executions.length > 0) {
        targets.push({
          executions,
          kind: 'class',
          name: classNode.name,
        })
      }
    }

    for (const functionNode of preparedFile.units.functions) {
      const executions = ruleRuntimes
        .map((runtime): RuleTargetExecution | undefined => {
          if (!runtime.handlers.onFunction)
            return undefined

          return {
            run: () => runtime.handlers.onFunction?.(functionNode),
            runtime,
          }
        })
        .filter((execution): execution is RuleTargetExecution => execution !== undefined)

      if (executions.length > 0) {
        targets.push({
          executions,
          kind: 'function',
          name: functionNode.name,
        })
      }
    }
  }

  return targets
}

function createAlintRunError(error: unknown, result: RunResult): AlintRunError {
  if (error instanceof AlintRunError) {
    return error
  }

  if (error instanceof AlintRuleExecutionError) {
    return new AlintRunError(error.message, result, {
      cause: error.cause,
      failure: error.failure,
    })
  }

  return new AlintRunError(toErrorMessage(error), result, {
    cause: error,
  })
}

function createPreparedFileExecutionPlans(
  ruleRuntimes: RuleRuntime[],
  files: PreparedFile[],
): PreparedFileExecutionPlan[] {
  return files.map((preparedFile, fileOffset) => {
    const filePlan: PreparedFileExecutionPlan = {
      fileIndex: fileOffset + 1,
      planned: 0,
      preparedFile,
      targets: collectExecutionTargets(ruleRuntimes, preparedFile),
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
  let completed = 0
  let errored = 0

  return {
    complete() {
      completed += 1
    },
    error() {
      errored += 1
    },
    snapshot(planned: number) {
      return {
        cached: 0,
        completed,
        errored,
        planned,
      }
    },
  }
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
            clock,
            counters,
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
  clock: () => number,
  counters: ReturnType<typeof createRuleEndCounters>,
  options: RunOptions,
): Promise<void> {
  const startedAt = clock()

  options.progress?.onRuleStart?.({
    path,
    startedAt,
  })

  let handlerError: unknown
  let handlerSucceeded = false

  try {
    await execution.runtime.executionState.run({
      activeFilePath: path.file.path,
      progressPath: path,
    }, execution.run)
    handlerSucceeded = true
  }
  catch (error) {
    handlerError = error
  }

  if (handlerSucceeded) {
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

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

function toProgressFilePath(filePlan: PreparedFileExecutionPlan, filesTotal: number) {
  return {
    index: filePlan.fileIndex,
    path: filePlan.preparedFile.file.path,
    planned: filePlan.planned,
    total: filesTotal,
  }
}
