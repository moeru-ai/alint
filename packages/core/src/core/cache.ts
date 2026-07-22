import type { RunnerConfig } from '../config/types'
import type { SourceLocation, SourceRange } from './source/types'
import type { Diagnostic, InferenceUsageRecord, ProgressTargetKind } from './types'

import process from 'node:process'

import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { array, check, description, is, literal, number, object, optional, pipe, record, string, union, unknown } from 'valibot'

import { stableHash } from './hash'

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
  identity?: string
  kind: ProgressTargetKind
  name?: string
  range?: {
    end: number
    start: number
  }
}

const CacheFileSchema = pipe(
  object({
    createdAt: pipe(string(), description('Cache file creation timestamp.')),
    entries: pipe(unknown(), check(value => typeof value === 'object' && value !== null && !Array.isArray(value)), record(string(), object({
      diagnostics: pipe(array(object({
        filePath: pipe(string(), description('Diagnostic file path.')),
        message: pipe(string(), description('Diagnostic message.')),
        ruleId: pipe(string(), description('Diagnostic rule id.')),
        severity: pipe(union([literal('error'), literal('warn')]), description('Diagnostic severity.')),
      })), description('Diagnostics produced for the cached target.')),
      filePath: pipe(string(), description('Cache entry file path.')),
      fingerprint: pipe(object({
        alintVersion: pipe(string(), description('Alint version used to create the cache entry.')),
        configHash: pipe(string(), description('Runner config hash used to create the cache entry.')),
        modelHash: pipe(string(), description('Model configuration hash used to create the cache entry.')),
        ruleHash: pipe(string(), description('Rule configuration hash used to create the cache entry.')),
      }), description('Cache entry fingerprint.')),
      target: pipe(object({
        hash: pipe(string(), description('Cached target hash.')),
        identity: pipe(string(), description('Stable cached target identity.')),
        kind: pipe(string(), description('Cached target kind.')),
      }), description('Cached target metadata.')),
      usage: pipe(array(object({
        inputTokens: pipe(optional(number()), description('Optional input token count.')),
        modelId: pipe(string(), description('Usage model id.')),
        outputTokens: pipe(optional(number()), description('Optional output token count.')),
        providerId: pipe(string(), description('Usage provider id.')),
        ruleId: pipe(string(), description('Usage rule id.')),
        totalTokens: pipe(optional(number()), description('Optional total token count.')),
      })), description('Inference usage records for the cache entry.')),
    })), description('Cache entries keyed by cache key.')),
    files: pipe(unknown(), check(value => typeof value === 'object' && value !== null && !Array.isArray(value)), record(string(), object({
      contentHash: pipe(string(), description('Cached file content hash.')),
      entries: pipe(array(string()), description('Cache entry keys associated with the file.')),
      path: pipe(string(), description('Normalized cached file path.')),
    })), description('Cached files keyed by normalized file path.')),
    schemaVersion: pipe(literal(CACHE_SCHEMA_VERSION), description('Cache schema version.')),
    updatedAt: pipe(string(), description('Cache file update timestamp.')),
  }),
  description('Alint cache file.'),
)

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

function createBaseTargetIdentity(target: TargetIdentityInput): string {
  if (target.identity && (target.kind !== 'file' || target.identity !== 'file')) {
    return target.filePath
      ? `${target.kind}:${target.filePath}:${target.identity}`
      : `${target.kind}:${target.identity}`
  }

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

function isCacheFile(value: unknown): value is CacheFile {
  return is(CacheFileSchema, value)
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

function statSyncIsDirectory(path: string): boolean {
  // Avoid making resolveCacheLocation async; existing directories are the only
  // filesystem-sensitive case in the public API.
  return statSync(path).isDirectory()
}
