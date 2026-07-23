import type { CacheStore } from '../cache'
import type { RuleScheduler } from '../execution/scheduler'
import type { ExecutionTarget, RuleJob, RuleJobOutcome, RuleRuntime, RuleTargetExecution } from '../execution/types'
import type { PreparedInput } from '../preparation'
import type { ProjectFileSnapshot } from '../project'
import type { AlintFileFailure, ProgressReporter } from '../types'
import type { ClassTarget, FileTarget, FunctionTarget, SourceRuntime, SourceSessionMetrics, SourceTarget } from './types'

import { errorMessageFrom } from '@moeru/std/error'

import { createTargetIdentityResolver, normalizeCachePath } from '../cache'
import { hashText, stableHash } from '../hash'

export const MAX_ACTIVE_SOURCE_SESSIONS = 4

export interface ExecuteSourceSessionOptions {
  cacheStore: CacheStore
  cwd: string
  metrics?: SourceSessionMetrics
  progress?: ProgressReporter
  projectSnapshots?: boolean
  ruleRuntimes: RuleRuntime[]
  scheduler: RuleScheduler
  signal?: AbortSignal
  src: SourceRuntime
}

export interface ExecuteSourceSessionsOptions extends Omit<ExecuteSourceSessionOptions, 'ruleRuntimes'> {
  createRuleRuntimes: (input: PreparedInput) => RuleRuntime[]
  sourceWindow: number
}

export interface SourceSessionResult {
  failure?: AlintFileFailure
  outcomes: RuleJobOutcome[]
  project?: ProjectFileSnapshot
}

interface SourceExecutionTarget {
  executions: RuleTargetExecution[]
  target: ExecutionTarget
  targetIndex: number
}

export async function executeSourceSession(
  input: PreparedInput,
  options: ExecuteSourceSessionOptions,
): Promise<SourceSessionResult> {
  openSession(options.metrics)
  try {
    if (options.signal?.aborted)
      return { outcomes: [] }

    let file
    try {
      file = await options.src.readFile(input.path)
    }
    catch (error) {
      return { failure: fileFailure(input, 'read', failureMessage(error, 'Failed to read source file.')), outcomes: [] }
    }

    if (options.signal?.aborted)
      return { outcomes: [] }

    let targets: SourceTarget[]
    try {
      targets = await input.language.extract(file, {
        cwd: options.cwd,
        languageOptions: input.languageOptions,
        src: options.src,
      })
    }
    catch (error) {
      return { failure: fileFailure(input, 'extract', failureMessage(error, 'Failed to extract source targets.')), outcomes: [] }
    }

    const contentHash = hashText(file.text)
    const project = options.projectSnapshots === false
      ? undefined
      : createProjectSnapshot(input, file.language, file.path, contentHash, targets)
    const cacheOwner = options.cacheStore.beginOwner({ kind: 'file', path: file.path })
    const executionTargets = createExecutionTargets(input, targets, options.ruleRuntimes, options.cwd, cacheOwner)
    const jobs = createSourceJobs(input, executionTargets)

    if (options.signal?.aborted) {
      cacheOwner.commit({ contentHash, mode: 'merge' })
      return { outcomes: [], project }
    }

    const batch = options.scheduler.schedule(jobs)
    try {
      options.progress?.onFileReady?.({
        fileIndex: input.fileIndex,
        inputPath: input.path,
        jobsAdded: batch.jobsAdded,
        progress: options.scheduler.snapshot(),
      })
    }
    catch (error) {
      options.scheduler.cancelWithError(error)
      throw error
    }
    const outcomes = await batch.outcomes
    cacheOwner.commit(options.signal?.aborted ? { contentHash, mode: 'merge' } : { contentHash })

    return { outcomes, project }
  }
  finally {
    closeSession(options.metrics)
  }
}

export async function executeSourceSessions(
  inputs: readonly PreparedInput[],
  options: ExecuteSourceSessionsOptions,
): Promise<SourceSessionResult[]> {
  const results: Array<SourceSessionResult | undefined> = new Array(inputs.length)
  let cursor = 0
  let firstError: unknown
  let failed = false
  let stopping = false
  const workerCount = Math.min(options.sourceWindow, inputs.length)

  // NOTICE: A session retains parser and target text until every admitted job settles. This
  // cap is the memory invariant that prevents a run from retaining every source at once.
  const workers = Array.from({ length: workerCount }, async () => {
    while (!stopping && !options.signal?.aborted) {
      const index = cursor
      cursor += 1
      const input = inputs[index]
      if (!input)
        return
      try {
        results[index] = await executeSourceSession(input, {
          ...options,
          ruleRuntimes: options.createRuleRuntimes(input),
        })
      }
      catch (error) {
        stopping = true
        if (!failed) {
          failed = true
          firstError = error
        }
      }
    }
  })

  await Promise.all(workers)
  if (failed)
    throw firstError
  return results.filter((result): result is SourceSessionResult => result !== undefined)
}

export function resolveSourceWindow(ruleConcurrency: number): number {
  return Math.max(1, Math.min(ruleConcurrency, MAX_ACTIVE_SOURCE_SESSIONS))
}

function closeSession(metrics: SourceSessionMetrics | undefined): void {
  if (!metrics)
    return
  metrics.active -= 1
  metrics.closed += 1
}

function createExecutionTargets(
  input: PreparedInput,
  targets: SourceTarget[],
  runtimes: RuleRuntime[],
  cwd: string,
  cacheOwner: ReturnType<CacheStore['beginOwner']>,
): SourceExecutionTarget[] {
  const resolveIdentity = createTargetIdentityResolver(targets.map(target => ({
    filePath: target.kind === 'file' ? normalizeCachePath(cwd, input.path) : undefined,
    identity: target.identity,
    kind: target.kind,
    name: target.name,
    range: target.range,
  })))

  return targets.map((target, targetIndex) => {
    const executions = runtimes
      .map(runtime => sourceExecution(runtime, target))
      .filter((execution): execution is RuleTargetExecution => execution !== undefined)
    return {
      executions,
      target: {
        activeFilePath: input.path,
        cacheOwner,
        configHash: input.configHash,
        identity: resolveIdentity({
          filePath: target.kind === 'file' ? normalizeCachePath(cwd, input.path) : undefined,
          identity: target.identity,
          kind: target.kind,
          name: target.name,
          range: target.range,
        }, targetIndex),
        kind: target.kind,
        language: target.language,
        loc: target.loc,
        metadata: target.metadata,
        name: target.name,
        origin: target.origin,
        range: target.range,
        text: target.text,
      },
      targetIndex,
    }
  }).filter(target => target.executions.length > 0)
}

function createProjectSnapshot(
  input: PreparedInput,
  language: string,
  path: string,
  contentHash: string,
  targets: SourceTarget[],
): ProjectFileSnapshot {
  return {
    configHash: input.configHash,
    file: { contentHash, language, path, targetCount: targets.length },
    fileIndex: input.fileIndex,
    targets: targets.map(target => ({
      descriptor: {
        filePath: target.file.path,
        identity: target.identity,
        kind: target.kind,
        ...(target.name === undefined ? {} : { name: target.name }),
        ...(target.range === undefined ? {} : { range: { ...target.range } }),
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

function createSourceJobs(input: PreparedInput, targets: SourceExecutionTarget[]): RuleJob[] {
  return targets.flatMap(({ executions, target, targetIndex }) => executions.map((execution) => {
    const ruleId = execution.runtime.enabledRule.id
    return {
      execution,
      jobRef: {
        id: stableHash({ fileIndex: input.fileIndex, input: input.path, ruleId, targetIdentity: target.identity, targetIndex }),
        index: 0,
        inputPath: input.path,
        ruleId,
        target: { identity: target.identity, kind: target.kind, name: target.name },
      },
      orderKey: { inputIndex: input.fileIndex, ruleIndex: execution.runtime.ruleIndex, scope: 'source' as const, targetIndex },
      target,
    }
  }))
}

function failureMessage(error: unknown, fallback: string): string {
  try {
    return errorMessageFrom(error) ?? fallback
  }
  catch {
    return fallback
  }
}

function fileFailure(input: PreparedInput, kind: AlintFileFailure['kind'], message: string): AlintFileFailure {
  return { file: { index: input.fileIndex, path: input.path }, kind, message }
}

function openSession(metrics: SourceSessionMetrics | undefined): void {
  if (!metrics)
    return
  metrics.active += 1
  metrics.opened += 1
  metrics.maximumActive = Math.max(metrics.maximumActive, metrics.active)
}

function sourceExecution(runtime: RuleRuntime, target: SourceTarget): RuleTargetExecution | undefined {
  if (runtime.handlers.onTargetWith)
    return { run: () => runtime.handlers.onTargetWith?.(target), runtime }
  if (target.kind === 'class' && runtime.handlers.onTargetClass)
    return { run: () => runtime.handlers.onTargetClass?.(target as ClassTarget), runtime }
  if (target.kind === 'file' && runtime.handlers.onTargetFile)
    return { run: () => runtime.handlers.onTargetFile?.(target as FileTarget), runtime }
  if (target.kind === 'function' && runtime.handlers.onTargetFunction)
    return { run: () => runtime.handlers.onTargetFunction?.(target as FunctionTarget), runtime }
  return undefined
}
