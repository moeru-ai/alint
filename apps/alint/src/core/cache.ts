import type { RunnerConfig } from '../config/types'
import type { SourceLocation, SourceRange } from './source/types'
import type { Diagnostic, InferenceUsageRecord, ProgressTargetKind } from './types'

import process from 'node:process'

import { createHash, randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const CACHE_SCHEMA_VERSION = 1
const DEFAULT_CACHE_FILE_NAME = '.alintcache'

export interface CachedFile {
  contentHash: string
  entries: string[]
  path: string
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
  filePath: string
  fingerprint: CacheFingerprint
  target: CachedTarget
  usage: InferenceUsageRecord[]
}

export interface CacheFile {
  createdAt: string
  entries: Record<string, CacheEntry>
  files: Record<string, CachedFile>
  schemaVersion: typeof CACHE_SCHEMA_VERSION
  updatedAt: string
}

export interface CacheFingerprint {
  alintVersion: string
  configHash: string
  modelHash: string
  ruleHash: string
}

export interface CacheKeyInput extends CacheFingerprint {
  filePath: string
  schemaVersion: typeof CACHE_SCHEMA_VERSION
  targetHash: string
  targetIdentity: string
  targetKind: ProgressTargetKind
}

export interface CacheStore {
  get: (key: string) => CacheEntry | undefined
  location: string
  markFile: (filePath: string, contentHash: string, entries: string[]) => void
  reconcile: () => Promise<void>
  set: (key: string, entry: CacheEntry) => void
}

export interface CacheStoreOptions {
  cwd: string
  enabled: boolean
  location?: string
}

export interface NormalizedRunnerCacheConfig {
  enabled: boolean
  location: string
}

export interface TargetIdentityInput {
  filePath?: string
  kind: ProgressTargetKind
  name?: string
  range?: {
    end: number
    start: number
  }
}

export function createCacheKey(input: CacheKeyInput): string {
  return stableHash(input)
}

export async function createCacheStore(options: CacheStoreOptions): Promise<CacheStore> {
  const location = resolveCacheLocation(options.cwd, options.location)

  if (!options.enabled) {
    return createNoopCacheStore(location)
  }

  const cacheFile = await readCacheFile(location)

  return {
    get: key => cacheFile.entries[key],
    location,
    markFile: (filePath, contentHash, entries) => {
      const path = normalizeCachePath(options.cwd, filePath)

      cacheFile.files[path] = {
        contentHash,
        entries,
        path,
      }
    },
    reconcile: async () => {
      await mkdir(dirname(location), { recursive: true })

      cacheFile.updatedAt = new Date().toISOString()

      const tempPath = join(dirname(location), `.${DEFAULT_CACHE_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`)
      await writeFile(tempPath, `${JSON.stringify(cacheFile, null, 2)}\n`)
      await rename(tempPath, location)
    },
    set: (key, entry) => {
      cacheFile.entries[key] = entry
    },
  }
}

export function createTargetIdentityResolver(targets: TargetIdentityInput[]) {
  const baseCounts = new Map<string, number>()

  for (const target of targets) {
    const base = createBaseTargetIdentity(target)
    baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1)
  }

  return (target: TargetIdentityInput): string => {
    const base = createBaseTargetIdentity(target)

    if ((baseCounts.get(base) ?? 0) <= 1) {
      return base
    }

    if (target.range) {
      return `${base}:${target.range.start}:${target.range.end}`
    }

    return base
  }
}

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function normalizeCachePath(cwd: string, filePath: string): string {
  const resolvedPath = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath)
  return relative(cwd, resolvedPath).split(sep).join('/')
}

export function normalizeRunnerCacheConfig(
  cache: RunnerConfig['cache'],
  cwd: string,
): NormalizedRunnerCacheConfig {
  if (cache === false) {
    return {
      enabled: false,
      location: resolveCacheLocation(cwd),
    }
  }

  if (cache === true || cache === undefined) {
    return {
      enabled: true,
      location: resolveCacheLocation(cwd),
    }
  }

  return {
    enabled: cache.enabled ?? true,
    location: resolveCacheLocation(cwd, cache.location),
  }
}

export function resolveCacheLocation(cwd: string, location?: string): string {
  if (!location) {
    return join(cwd, DEFAULT_CACHE_FILE_NAME)
  }

  const resolved = isAbsolute(location) ? resolve(location) : resolve(cwd, location)

  if (location.endsWith('/') || location.endsWith('\\')) {
    return join(resolved, DEFAULT_CACHE_FILE_NAME)
  }

  try {
    if (statSyncIsDirectory(resolved)) {
      return join(resolved, DEFAULT_CACHE_FILE_NAME)
    }
  }
  catch {
    // Missing locations without a trailing separator are treated as file paths.
  }

  return resolved
}

export function stableHash(value: unknown): string {
  return hashText(stableStringify(value))
}

function createBaseTargetIdentity(target: TargetIdentityInput): string {
  if (target.kind === 'file') {
    return target.filePath ? `file:${target.filePath}` : 'file'
  }

  if (target.name) {
    return `${target.kind}:${target.name}`
  }

  if (target.range) {
    return `${target.kind}:${target.range.start}:${target.range.end}`
  }

  return target.kind
}

function createEmptyCacheFile(): CacheFile {
  const now = new Date().toISOString()

  return {
    createdAt: now,
    entries: {},
    files: {},
    schemaVersion: CACHE_SCHEMA_VERSION,
    updatedAt: now,
  }
}

function createNoopCacheStore(location: string): CacheStore {
  return {
    get: () => undefined,
    location,
    markFile: () => {},
    reconcile: async () => {},
    set: () => {},
  }
}

function isCachedFile(value: unknown): value is CachedFile {
  if (!isRecord(value)) {
    return false
  }

  return typeof value.contentHash === 'string'
    && Array.isArray(value.entries)
    && value.entries.every(entry => typeof entry === 'string')
    && typeof value.path === 'string'
}

function isCachedTarget(value: unknown): value is CachedTarget {
  if (!isRecord(value)) {
    return false
  }

  return typeof value.hash === 'string'
    && typeof value.identity === 'string'
    && isTargetKind(value.kind)
}

function isCacheEntry(value: unknown): value is CacheEntry {
  if (!isRecord(value)) {
    return false
  }

  return Array.isArray(value.diagnostics)
    && value.diagnostics.every(isDiagnostic)
    && typeof value.filePath === 'string'
    && isCacheFingerprint(value.fingerprint)
    && isCachedTarget(value.target)
    && Array.isArray(value.usage)
    && value.usage.every(isUsageRecord)
}

function isCacheFile(value: unknown): value is CacheFile {
  if (!isRecord(value)) {
    return false
  }

  return value.schemaVersion === CACHE_SCHEMA_VERSION
    && typeof value.createdAt === 'string'
    && isRecord(value.entries)
    && Object.values(value.entries).every(isCacheEntry)
    && isRecord(value.files)
    && Object.values(value.files).every(isCachedFile)
    && typeof value.updatedAt === 'string'
}

function isCacheFingerprint(value: unknown): value is CacheFingerprint {
  if (!isRecord(value)) {
    return false
  }

  return typeof value.alintVersion === 'string'
    && typeof value.configHash === 'string'
    && typeof value.modelHash === 'string'
    && typeof value.ruleHash === 'string'
}

function isDiagnostic(value: unknown): value is Diagnostic {
  if (!isRecord(value)) {
    return false
  }

  return typeof value.filePath === 'string'
    && typeof value.message === 'string'
    && typeof value.ruleId === 'string'
    && (value.severity === 'error' || value.severity === 'warn')
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === 'number'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTargetKind(value: unknown): value is ProgressTargetKind {
  return value === 'file' || value === 'class' || value === 'function'
}

function isUsageRecord(value: unknown): value is InferenceUsageRecord {
  if (!isRecord(value)) {
    return false
  }

  return typeof value.modelId === 'string'
    && typeof value.providerId === 'string'
    && typeof value.ruleId === 'string'
    && isOptionalNumber(value.inputTokens)
    && isOptionalNumber(value.outputTokens)
    && isOptionalNumber(value.totalTokens)
}

async function readCacheFile(location: string): Promise<CacheFile> {
  try {
    const parsed = JSON.parse(await readFile(location, 'utf8')) as unknown

    if (isCacheFile(parsed)) {
      return parsed
    }
  }
  catch {
    // Missing, malformed, and unreadable cache files start from an empty cache.
  }

  return createEmptyCacheFile()
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(',')}]`
  }

  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => {
      const property = value[key]

      if (property === undefined) {
        return undefined
      }

      return `${JSON.stringify(key)}:${stableStringify(property)}`
    }).filter((entry): entry is string => entry !== undefined).join(',')}}`
  }

  return JSON.stringify(value)
}

function statSyncIsDirectory(path: string): boolean {
  // Avoid making resolveCacheLocation async; existing directories are the only
  // filesystem-sensitive case in the public API.
  return statSync(path).isDirectory()
}
