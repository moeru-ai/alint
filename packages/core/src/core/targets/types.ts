import type { AsyncLocalStorage } from 'node:async_hooks'

import type { Awaitable, EnabledRule, RuleHandlers } from '../../dsl/types'
import type { CacheEntry, CacheOwnerTransaction } from '../cache'
import type { SourceFile, SourceTarget } from '../source/types'
import type { Diagnostic, InferenceUsageRecord, ProgressJob, ProgressTargetKind } from '../types'

export interface CacheRunContext {
  modelHash: string
}

export interface ExecutionTarget {
  activeFilePath?: string
  cacheOwner?: CacheOwnerTransaction
  cacheTargetHash?: string
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
  fileIndex: number
  ruleRuntimes: RuleRuntime[]
  targets: SourceTarget[]
}

export interface PreparedFileExecutionPlan extends TargetExecutionPlan {
  cacheOwner: CacheOwnerTransaction
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
  // Zero-based enabled-registry position, distinct from a job's per-rule occurrence index.
  ruleIndex: number
}

export interface RuleRuntimeState {
  activeFilePath?: string
  bucket: RuleExecutionBucket
  currentModel?: { providerId: string, requested?: string, resolvedId: string }
  jobRef: ProgressJob
  reporterCause?: unknown
  reporterFailed: boolean
  sealed: boolean
  signal: AbortSignal
}

export interface RuleTargetExecution {
  run: () => Awaitable<void>
  runtime: RuleRuntime
}

export interface TargetExecutionPlan {
  id: string
  index: number
  kind: 'directory' | 'project' | 'source'
  path: string
  planned: number
  targets: ExecutionTarget[]
}
