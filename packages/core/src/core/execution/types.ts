import type { AsyncLocalStorage } from 'node:async_hooks'

import type { Awaitable, EnabledRule, RuleHandlers } from '../../dsl/types'
import type { CacheEntry, CacheOwnerTransaction } from '../cache'
import type { SourceTarget } from '../source/types'
import type { AlintRuleFailure, Diagnostic, InferenceUsageRecord, ProgressJobRef } from '../types'
import type { RunProgress } from './progress'

export interface CacheRunContext {
  modelHash: string
}

export interface ExecutionTarget {
  activeFilePath?: string
  cacheOwner?: CacheOwnerTransaction
  cacheTargetHash?: string
  configHash: string
  identity: string
  kind: ProgressJobRef['target']['kind']
  language: string
  loc?: CacheEntry['target']['loc']
  metadata?: Record<string, unknown>
  name?: string
  origin?: SourceTarget['origin']
  range?: CacheEntry['target']['range']
  text: string
}

export interface JobOrderKey {
  inputIndex: number
  ruleIndex: number
  scope: JobScope
  targetIndex: number
}

export type JobScope = 'directory' | 'project' | 'source'

export interface RuleExecutionBucket {
  diagnostics: Diagnostic[]
  usage: InferenceUsageRecord[]
}

export interface RuleJob {
  execution: RuleTargetExecution
  jobRef: ProgressJobRef
  orderKey: JobOrderKey
  target: ExecutionTarget
}

export type RuleJobOutcome = TerminalOutcome & {
  diagnostics: Diagnostic[]
  jobRef: ProgressJobRef
  orderKey: JobOrderKey
  usage: InferenceUsageRecord[]
}

export interface RuleRuntime {
  cacheable: boolean
  enabledRule: EnabledRule
  executionState: AsyncLocalStorage<RuleRuntimeState>
  handlers: RuleHandlers
  ruleHash: string
  ruleIndex: number
}

export interface RuleRuntimeState {
  activeFilePath?: string
  bucket: RuleExecutionBucket
  currentModel?: { providerId: string, requested?: string, resolvedId: string }
  jobRef: ProgressJobRef
  reporterCause?: unknown
  reporterFailed: boolean
  runProgress: RunProgress
  sealed: boolean
  signal: AbortSignal
}

export interface RuleTargetExecution {
  run: () => Awaitable<void>
  runtime: RuleRuntime
}

export type TerminalOutcome
  = | { cache: 'hit', failure?: never, state: 'cached' }
    | { cache: 'hit' | 'miss', failure: AlintRuleFailure, state: 'failed' }
    | { cache: 'miss', failure?: never, state: 'cancelled' }
    | { cache: 'miss', failure?: never, state: 'completed' }
    | { cache: 'miss', failure?: never, state: 'skipped' }
