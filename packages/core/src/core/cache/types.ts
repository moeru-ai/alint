import type { SourceLocation, SourceRange } from '../source/types'
import type { Diagnostic, InferenceUsageRecord, ProgressTargetKind } from '../types'

export const CACHE_SCHEMA_VERSION = 2
export const CACHE_HEADER_LIMIT = 256
export const CACHE_MAGIC = 'ALINT_CACHE'

export interface CachedOwner {
  contentHash?: string
  kind: CacheOwnerKind
  path: string
  slots: string[]
}

export interface CachedTarget {
  hash: string
  identity: string
  kind: ProgressTargetKind
  loc?: SourceLocation
  name?: string
  range?: SourceRange
}

export interface CacheEntry {
  diagnostics: Diagnostic[]
  fingerprint: CacheFingerprint
  target: CachedTarget
  usage: InferenceUsageRecord[]
}

export interface CacheFileBody {
  createdAt: string
  entries: Record<string, CacheEntry>
  owners: Record<string, CachedOwner>
  updatedAt: string
}

export interface CacheFingerprint {
  configHash: string
  modelHash: string
  ruleHash: string
  targetHash: string
}

export interface CacheOwnerIdentity {
  kind: CacheOwnerKind
  path: string
}

export type CacheOwnerKind = 'file' | 'project'

export interface CacheOwnerTransaction {
  commit: (metadata?: { contentHash?: string, mode?: 'merge' | 'replace' }) => void
  discard: (slot: CacheSlotIdentity) => void
  lookup: (slot: CacheSlotIdentity, fingerprint: CacheFingerprint) => CacheEntry | undefined
  put: (slot: CacheSlotIdentity, entry: CacheEntry) => void
}

export interface CacheSlotIdentity {
  ruleId: string
  scope: ProgressTargetKind
  targetIdentity: string
}

export interface CacheStore {
  beginOwner: (owner: CacheOwnerIdentity) => CacheOwnerTransaction
  location: string
  reconcile: () => Promise<void>
}
