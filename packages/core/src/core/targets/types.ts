import type { AsyncLocalStorage } from 'node:async_hooks'

import type { Awaitable, EnabledRule, RuleHandlers } from '../../dsl/types'
import type { CacheEntry, CacheStore } from '../cache'
import type { SourceFile, SourceTarget } from '../source/types'
import type { Diagnostic, InferenceUsageRecord, ProgressPath, ProgressPlanKind, ProgressTargetKind } from '../types'

export interface CacheRunContext {
  cwd: string
  enabled: boolean
  fileEntryKeys: Map<string, Set<string>>
  modelHash: string
  store: CacheStore
}

export interface ExecutionTarget {
  activeFilePath?: string
  cacheFilePaths: string[]
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

export interface PreparedFile {
  configHash: string
  file: SourceFile
  ruleRuntimes: RuleRuntime[]
  targets: SourceTarget[]
}

export interface PreparedFileExecutionPlan extends TargetExecutionPlan {
  preparedFile: PreparedFile
}

export interface RuleExecutionBucket {
  diagnostics: Diagnostic[]
  usage: InferenceUsageRecord[]
}

export interface RuleRuntime {
  cacheable: boolean
  enabledRule: EnabledRule
  executionState: AsyncLocalStorage<RuleRuntimeState>
  handlers: RuleHandlers
  ruleHash: string
}

export interface RuleRuntimeState {
  activeFilePath?: string
  bucket: RuleExecutionBucket
  currentModel?: { providerId: string, requested?: string, resolvedId: string }
  progressPath: ProgressPath
  signal: AbortSignal
}

export interface RuleTargetExecution {
  run: () => Awaitable<void>
  runtime: RuleRuntime
}

export interface TargetExecutionPlan {
  id: string
  index: number
  kind: ProgressPlanKind
  path: string
  planned: number
  targets: ExecutionTarget[]
}
