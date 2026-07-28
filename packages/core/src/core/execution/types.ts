import type { AsyncLocalStorage } from 'node:async_hooks'

import type { EnabledRule, RuleHandlers, Target } from '../../dsl/types'
import type { CacheEntry, CacheOwnerTransaction } from '../cache'
import type { AlintRuleFailure, Diagnostic, InferenceUsageRecord, ProgressJobRef } from '../types'
import type { RunProgress } from './progress'

export interface CacheRunContext {
  modelHash: string
}

export interface ExecutionTarget {
  activeFilePath?: string
  cacheOwner?: CacheOwnerTransaction
  cacheTargetHash: string
  configHash: string
  descriptor: Target
  identity: string
  kind: ProgressJobRef['target']['kind']
  loc?: CacheEntry['target']['loc']
  name?: string
  range?: CacheEntry['target']['range']
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
  handler: 'class' | 'directory' | 'file' | 'function' | 'language-declaration-error' | 'project' | 'with'
  runtime: RuleRuntime
}

export type TerminalOutcome
  = | { cache: 'hit', failure?: never, state: 'cached' }
    | { cache: 'hit' | 'miss', failure: AlintRuleFailure, state: 'failed' }
    | { cache: 'miss', failure?: never, state: 'cancelled' }
    | { cache: 'miss', failure?: never, state: 'completed' }
    | { cache: 'miss', failure?: never, state: 'skipped' }
