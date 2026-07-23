import type { FileHandle } from 'node:fs/promises'

import type { RunnerConfig } from '../../config/types'
import type { ProgressTargetKind } from '../types'
import type {
  CachedOwner,
  CacheEntry,
  CacheFileBody,
  CacheFingerprint,
  CacheOwnerIdentity,
  CacheOwnerTransaction,
  CacheSlotIdentity,
  CacheStore,
} from './types'

import process from 'node:process'

import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { access, mkdir, open, readFile, rename, rm, writeFile as writeFileToDisk } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import {
  array,
  boolean,
  check,
  custom,
  finite,
  literal,
  number,
  object,
  optional,
  parse,
  pipe,
  record,
  string,
  union,
  unknown,
} from 'valibot'

import packageJson from '../../../package.json'

import { stableHash } from '../hash'
import { CACHE_HEADER_LIMIT, CACHE_MAGIC, CACHE_SCHEMA_VERSION } from './types'

const DEFAULT_CACHE_FILE_NAME = '.alintcache'

export interface CacheStoreOptions {
  alintVersion?: string
  cwd: string
  enabled: boolean
  fileExists?: (path: string) => Promise<boolean>
  location?: string
  readOnly?: boolean
  writeFile?: typeof writeFileToDisk
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

const FiniteNumberSchema = pipe(number(), finite())

const PositionSchema = object({
  column: FiniteNumberSchema,
  line: FiniteNumberSchema,
})

const SourceLocationSchema = object({
  end: PositionSchema,
  start: PositionSchema,
})

const DiagnosticLocationSchema = object({
  end: optional(PositionSchema),
  start: PositionSchema,
})

const SourceRangeSchema = object({
  end: FiniteNumberSchema,
  start: FiniteNumberSchema,
})

const DiagnosticSchema = object({
  cached: optional(boolean()),
  evidence: optional(custom<JsonValue>(isJsonValue)),
  filePath: string(),
  loc: optional(DiagnosticLocationSchema),
  message: string(),
  model: optional(object({
    providerId: string(),
    requested: optional(string()),
    resolvedId: string(),
  })),
  ruleId: string(),
  severity: union([literal('error'), literal('warn')]),
})

const UsageSchema = object({
  filePath: optional(string()),
  inputTokens: optional(FiniteNumberSchema),
  metadata: optional(custom<JsonValue>(isJsonValue)),
  modelId: string(),
  outputTokens: optional(FiniteNumberSchema),
  providerId: string(),
  ruleId: string(),
  totalTokens: optional(FiniteNumberSchema),
})

const CacheEntrySchema = object({
  diagnostics: array(DiagnosticSchema),
  fingerprint: object({
    configHash: string(),
    modelHash: string(),
    ruleHash: string(),
    targetHash: string(),
  }),
  target: object({
    hash: string(),
    identity: string(),
    kind: string(),
    loc: optional(SourceLocationSchema),
    name: optional(string()),
    range: optional(SourceRangeSchema),
  }),
  usage: array(UsageSchema),
})

function objectRecord<ValueSchema extends Parameters<typeof record>[1]>(value: ValueSchema) {
  return pipe(
    unknown(),
    check(input => typeof input === 'object' && input !== null && !Array.isArray(input)),
    record(string(), value),
  )
}

const CacheFileBodySchema = pipe(
  object({
    createdAt: string(),
    entries: objectRecord(CacheEntrySchema),
    owners: objectRecord(object({
      contentHash: optional(string()),
      kind: union([literal('file'), literal('project')]),
      path: string(),
      slots: array(string()),
    })),
    updatedAt: string(),
  }),
  check((body) => {
    const entryKeys = Object.keys(body.entries)
    const referencedSlots = Object.values(body.owners).flatMap(owner => owner.slots)
    const uniqueSlots = new Set(referencedSlots)
    return uniqueSlots.size === referencedSlots.length
      && uniqueSlots.size === entryKeys.length
      && entryKeys.every(key => uniqueSlots.has(key))
  }),
)

type JsonValue = boolean | JsonValue[] | null | number | string | { [key: string]: JsonValue }

export async function createCacheStore(options: CacheStoreOptions): Promise<CacheStore> {
  const location = resolveCacheLocation(options.cwd, options.location)
  if (!options.enabled)
    return createNoopCacheStore(location)

  const alintVersion = options.alintVersion ?? packageJson.version
  const header = `${CACHE_MAGIC} ${CACHE_SCHEMA_VERSION} ${alintVersion}`
  const body = await loadCacheBody(location, header, options.readOnly === true)
  if (options.readOnly)
    return createReadOnlyCacheStore(location, body, options.cwd)
  const fileExists = options.fileExists ?? defaultFileExists
  const writeFile = options.writeFile ?? writeFileToDisk

  return {
    beginOwner: owner => beginOwner(body, owner, options.cwd),
    location,
    reconcile: async () => {
      await collectMissingFileOwners(body, options.cwd, fileExists)
      body.updatedAt = new Date().toISOString()
      await persistCacheBody(location, header, body, writeFile)
    },
  }
}

export function createTargetIdentityResolver(targets: TargetIdentityInput[]) {
  const baseCounts = new Map<string, number>()
  const duplicateCandidateCounts = new Map<string, number>()
  for (const target of targets) {
    const base = createBaseTargetIdentity(target)
    baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1)
  }
  for (const target of targets) {
    const base = createBaseTargetIdentity(target)
    if ((baseCounts.get(base) ?? 0) <= 1)
      continue
    const candidate = target.range ? `${base}:${target.range.start}:${target.range.end}` : base
    duplicateCandidateCounts.set(candidate, (duplicateCandidateCounts.get(candidate) ?? 0) + 1)
  }

  return (target: TargetIdentityInput, targetIndex: number): string => {
    const base = createBaseTargetIdentity(target)
    if ((baseCounts.get(base) ?? 0) <= 1)
      return base
    const candidate = target.range ? `${base}:${target.range.start}:${target.range.end}` : base
    if ((duplicateCandidateCounts.get(candidate) ?? 0) <= 1)
      return candidate
    return `${candidate}:${targetIndex}`
  }
}

export function normalizeCachePath(cwd: string, filePath: string): string {
  const resolvedPath = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath)
  return relative(cwd, resolvedPath).split(sep).join('/') || '.'
}

export function normalizeRunnerCacheConfig(
  cache: RunnerConfig['cache'],
  cwd: string,
): NormalizedRunnerCacheConfig {
  if (cache === false) {
    return { enabled: false, location: resolveCacheLocation(cwd) }
  }
  if (cache === true || cache === undefined) {
    return { enabled: true, location: resolveCacheLocation(cwd) }
  }
  return {
    enabled: cache.enabled ?? true,
    location: resolveCacheLocation(cwd, cache.location),
  }
}

export async function readCacheBody(location: string): Promise<CacheFileBody> {
  const text = await readFile(location, 'utf8')
  return parseCacheBody(text.slice(text.indexOf('\n') + 1))
}

export function resolveCacheLocation(cwd: string, location?: string): string {
  if (!location)
    return join(cwd, DEFAULT_CACHE_FILE_NAME)

  const resolved = isAbsolute(location) ? resolve(location) : resolve(cwd, location)
  if (location.endsWith('/') || location.endsWith('\\'))
    return join(resolved, DEFAULT_CACHE_FILE_NAME)

  try {
    if (statSync(resolved).isDirectory())
      return join(resolved, DEFAULT_CACHE_FILE_NAME)
  }
  catch {
    // Missing locations without a trailing separator are treated as file paths.
  }
  return resolved
}

function beginOwner(body: CacheFileBody, owner: CacheOwnerIdentity, cwd: string): CacheOwnerTransaction {
  const normalizedOwner = { kind: owner.kind, path: normalizeCachePath(cwd, owner.path) }
  const key = ownerKey(normalizedOwner, cwd)
  const previousOwner = body.owners[key]
  const nextEntries = new Map<string, CacheEntry>()

  return {
    commit: (metadata = {}) => {
      const committedEntries = metadata.mode === 'merge'
        ? ownerEntries(body, body.owners[key])
        : new Map<string, CacheEntry>()
      for (const [entryKey, cacheEntry] of nextEntries)
        committedEntries.set(entryKey, cacheEntry)

      // Replace owns the final snapshot; merge rebases on the current snapshot. Clear every
      // slot visible to either boundary before publishing the computed owner atomically.
      const replacedSlots = new Set([
        ...(previousOwner?.slots ?? []),
        ...(body.owners[key]?.slots ?? []),
      ])
      for (const replacedSlot of replacedSlots)
        delete body.entries[replacedSlot]
      for (const [entryKey, cacheEntry] of committedEntries)
        body.entries[entryKey] = cacheEntry

      body.owners[key] = {
        contentHash: metadata.contentHash,
        kind: normalizedOwner.kind,
        path: normalizedOwner.path,
        slots: [...committedEntries.keys()].sort(),
      }
      body.updatedAt = new Date().toISOString()
    },
    discard: cacheSlot => nextEntries.delete(slotKey(normalizedOwner, cacheSlot, cwd)),
    lookup: (cacheSlot, fingerprint) => {
      const entryKey = slotKey(normalizedOwner, cacheSlot, cwd)
      const cached = body.entries[entryKey]
      if (!cached || !fingerprintsEqual(cached.fingerprint, fingerprint))
        return undefined
      nextEntries.set(entryKey, cached)
      return cached
    },
    put: (cacheSlot, cacheEntry) => nextEntries.set(slotKey(normalizedOwner, cacheSlot, cwd), cacheEntry),
  }
}

async function collectMissingFileOwners(
  body: CacheFileBody,
  cwd: string,
  fileExists: (path: string) => Promise<boolean>,
): Promise<void> {
  for (const [key, owner] of Object.entries(body.owners)) {
    if (owner.kind !== 'file' || await fileExists(resolve(cwd, owner.path)))
      continue
    for (const entryKey of owner.slots)
      delete body.entries[entryKey]
    delete body.owners[key]
  }
}

function createBaseTargetIdentity(target: TargetIdentityInput): string {
  if (target.identity && (target.kind !== 'file' || target.identity !== 'file')) {
    return target.filePath
      ? `${target.kind}:${target.filePath}:${target.identity}`
      : `${target.kind}:${target.identity}`
  }
  if (target.kind === 'file')
    return target.filePath ? `file:${target.filePath}` : 'file'
  if (target.name)
    return `${target.kind}:${target.name}`
  if (target.range)
    return `${target.kind}:${target.range.start}:${target.range.end}`
  return target.kind
}

function createEmptyCacheBody(): CacheFileBody {
  const now = new Date().toISOString()
  return { createdAt: now, entries: {}, owners: {}, updatedAt: now }
}

function createNoopCacheStore(location: string): CacheStore {
  const transaction: CacheOwnerTransaction = {
    commit: () => {},
    discard: () => {},
    lookup: () => undefined,
    put: () => {},
  }
  return {
    beginOwner: () => transaction,
    location,
    reconcile: async () => {},
  }
}

function createReadOnlyCacheStore(location: string, body: CacheFileBody, cwd: string): CacheStore {
  const transaction = (owner: CacheOwnerIdentity): CacheOwnerTransaction => ({
    commit: () => {},
    discard: () => {},
    lookup: (slot, fingerprint) => {
      const cached = body.entries[slotKey(owner, slot, cwd)]
      return cached && fingerprintsEqual(cached.fingerprint, fingerprint) ? cached : undefined
    },
    put: () => {},
  })
  return {
    beginOwner: transaction,
    location,
    reconcile: async () => {},
  }
}

async function defaultFileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  }
  catch (error) {
    if (isMissingFileError(error))
      return false
    throw error
  }
}

function fingerprintsEqual(left: CacheFingerprint, right: CacheFingerprint): boolean {
  return left.configHash === right.configHash
    && left.modelHash === right.modelHash
    && left.ruleHash === right.ruleHash
    && left.targetHash === right.targetHash
}

function hasJsonArrayProperties(input: unknown[], ancestors: WeakSet<object>): boolean {
  let arrayLength: number | undefined
  let indexCount = 0
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor || !('value' in descriptor))
      return false
    if (key === 'length') {
      if (descriptor.enumerable || typeof descriptor.value !== 'number')
        return false
      arrayLength = descriptor.value
      continue
    }
    if (typeof key !== 'string' || !isCanonicalArrayIndex(key) || !descriptor.enumerable)
      return false
    if (!isJsonValueAt(descriptor.value, ancestors))
      return false
    indexCount += 1
  }
  return arrayLength !== undefined && indexCount === arrayLength
}

function hasJsonObjectProperties(input: object, ancestors: WeakSet<object>): boolean {
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string')
      return false
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor))
      return false
    if (!isJsonValueAt(descriptor.value, ancestors))
      return false
  }
  return true
}

function isCanonicalArrayIndex(key: string): boolean {
  const index = Number(key)
  return Number.isInteger(index)
    && index >= 0
    && index < 2 ** 32 - 1
    && String(index) === key
}

function isJsonValue(input: unknown): input is JsonValue {
  return isJsonValueAt(input, new WeakSet())
}

function isJsonValueAt(input: unknown, ancestors: WeakSet<object>): input is JsonValue {
  if (input === null || typeof input === 'string' || typeof input === 'boolean')
    return true
  if (typeof input === 'number')
    return Number.isFinite(input)
  if (typeof input !== 'object')
    return false
  if (ancestors.has(input))
    return false
  ancestors.add(input)
  try {
    if (Array.isArray(input)) {
      if (Object.getPrototypeOf(input) !== Array.prototype)
        return false
      return hasJsonArrayProperties(input, ancestors)
    }
    if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
      return false
    return hasJsonObjectProperties(input, ancestors)
  }
  catch {
    return false
  }
  finally {
    ancestors.delete(input)
  }
}

function isMissingFileError(error: unknown): boolean {
  return isNodeErrorCode(error, 'ENOENT') || isNodeErrorCode(error, 'ENOTDIR')
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

async function loadCacheBody(location: string, expectedHeader: string, readOnly: boolean): Promise<CacheFileBody> {
  let handle: FileHandle | undefined
  try {
    handle = await open(location, 'r')
    const header = await readHeader(handle)
    await handle.close()
    handle = undefined
    if (header !== expectedHeader) {
      if (!readOnly)
        await rm(location, { force: true })
      return createEmptyCacheBody()
    }

    const text = await readFile(location, 'utf8')
    return parseCacheBody(text.slice(text.indexOf('\n') + 1))
  }
  catch (error) {
    await handle?.close().catch(() => {})
    if (isMissingFileError(error))
      return createEmptyCacheBody()
    if (!readOnly)
      await rm(location, { force: true }).catch(() => {})
    return createEmptyCacheBody()
  }
}

function ownerEntries(body: CacheFileBody, owner: CachedOwner | undefined): Map<string, CacheEntry> {
  const entries = new Map<string, CacheEntry>()
  for (const slot of owner?.slots ?? []) {
    const cacheEntry = body.entries[slot]
    if (cacheEntry)
      entries.set(slot, cacheEntry)
  }
  return entries
}

function ownerKey(owner: CacheOwnerIdentity, cwd: string): string {
  return stableHash({ kind: owner.kind, path: normalizeCachePath(cwd, owner.path) })
}

function parseCacheBody(text: string): CacheFileBody {
  const value: unknown = JSON.parse(text)
  return parse(CacheFileBodySchema, value)
}

async function persistCacheBody(
  location: string,
  header: string,
  body: CacheFileBody,
  writeFile: typeof writeFileToDisk,
): Promise<void> {
  const validatedBody = parse(CacheFileBodySchema, body)
  await mkdir(dirname(location), { recursive: true })
  const tempPath = join(dirname(location), `.${basename(location)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    await writeFile(tempPath, `${header}\n${JSON.stringify(validatedBody)}\n`)
    await rename(tempPath, location)
  }
  catch (error) {
    await rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
}

async function readHeader(handle: FileHandle): Promise<string | undefined> {
  const buffer = Buffer.alloc(CACHE_HEADER_LIMIT)
  const { bytesRead } = await handle.read(buffer, 0, CACHE_HEADER_LIMIT, 0)
  const newline = buffer.subarray(0, bytesRead).indexOf(10)
  return newline < 0 ? undefined : buffer.subarray(0, newline).toString('utf8')
}

function slotKey(owner: CacheOwnerIdentity, slot: CacheSlotIdentity, cwd: string): string {
  return stableHash({ owner: ownerKey(owner, cwd), ...slot })
}
