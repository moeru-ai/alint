import type {
  ModelSize,
  ProviderDefinition,
  ProviderType,
  RunnerConfig,
  SetupConfig,
  SetupModelDefinition,
} from '@alint-js/core'

import { parse, stringify } from 'smol-toml'

const modelSizes = new Set<ModelSize>(['large', 'medium', 'small'])

interface StringifiableProviderDefinition {
  endpoint: string
  headers?: Record<string, string>
  id: string
  models: StringifiableSetupModelDefinition[]
  type: ProviderType
}

interface StringifiableRunnerCacheConfig {
  enabled?: boolean
  location?: string
}

interface StringifiableRunnerConfig {
  cache?: boolean | StringifiableRunnerCacheConfig
  file_concurrency?: number
  rule_concurrency?: number
  stats?: boolean | StringifiableRunnerStatsConfig
  timeout_ms?: number
}

interface StringifiableRunnerStatsConfig {
  enabled?: boolean
  location?: string
  retention_months?: number
}

interface StringifiableSetupConfig {
  providers: StringifiableProviderDefinition[]
  runner?: StringifiableRunnerConfig
  version: 1
}

interface StringifiableSetupModelDefinition {
  aliases?: string[]
  capabilities?: string[]
  context_window?: number
  default_params?: Record<string, unknown>
  id: string
  name?: string
  size?: ModelSize
}

interface TomlProviderDefinition {
  endpoint?: unknown
  headers?: unknown
  id?: unknown
  models?: unknown
  type?: unknown
}

interface TomlRunnerCacheConfig {
  enabled?: unknown
  location?: unknown
}

interface TomlRunnerConfig {
  cache?: unknown
  file_concurrency?: unknown
  rule_concurrency?: unknown
  stats?: unknown
  timeout_ms?: unknown
}

interface TomlRunnerStatsConfig {
  enabled?: unknown
  location?: unknown
  retention_months?: unknown
}

interface TomlSetupConfig {
  providers?: unknown
  runner?: unknown
  version?: unknown
}

interface TomlSetupModelDefinition {
  aliases?: unknown
  capabilities?: unknown
  context_window?: unknown
  default_params?: unknown
  id?: unknown
  name?: unknown
  size?: unknown
}

export function parseSetupConfigToml(toml: string): SetupConfig {
  const rawConfig = parse(toml) as TomlSetupConfig

  if (rawConfig.version !== 1) {
    throw new Error('Invalid setup config: version must be 1.')
  }

  if (!Array.isArray(rawConfig.providers)) {
    throw new TypeError('Invalid setup config: providers must be an array.')
  }

  const parsedConfig: SetupConfig = {
    providers: rawConfig.providers.map(provider =>
      parseProvider(provider as TomlProviderDefinition),
    ),
    version: 1,
  }

  if (rawConfig.runner !== undefined) {
    parsedConfig.runner = parseRunner(rawConfig.runner as TomlRunnerConfig)
  }

  return parsedConfig
}

export function stringifySetupConfigToml(config: SetupConfig): string {
  const stringifiableConfig: StringifiableSetupConfig = {
    providers: config.providers.map(toTomlProvider),
    version: config.version,
  }

  if (config.runner !== undefined) {
    stringifiableConfig.runner = toTomlRunner(config.runner)
  }

  return stringify(stringifiableConfig)
}

function isModelSize(value: unknown): value is ModelSize {
  return typeof value === 'string' && modelSizes.has(value as ModelSize)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseModel(
  providerId: string,
  model: TomlSetupModelDefinition,
): SetupModelDefinition {
  const id = readNonEmptyString(model.id, `provider "${providerId}" model id`)
  const parsedModel: SetupModelDefinition = { id }

  if (model.name !== undefined) {
    parsedModel.name = readString(model.name, `model "${id}" name`)
  }

  if (model.aliases !== undefined) {
    parsedModel.aliases = readStringArray(model.aliases, `model "${id}" aliases`)
  }

  if (model.capabilities !== undefined) {
    parsedModel.capabilities = readStringArray(
      model.capabilities,
      `model "${id}" capabilities`,
    )
  }

  if (model.size !== undefined) {
    if (!isModelSize(model.size)) {
      throw new Error(
        `Invalid model "${id}": size must be "small", "medium", or "large".`,
      )
    }

    parsedModel.size = model.size
  }

  if (model.context_window !== undefined) {
    parsedModel.contextWindow = readFiniteNumber(
      model.context_window,
      `model "${id}" context_window`,
    )
  }

  if (model.default_params !== undefined) {
    parsedModel.defaultParams = readRecord(
      model.default_params,
      `model "${id}" default_params`,
    )
  }

  return parsedModel
}

function parsePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new TypeError(`Invalid ${label}: must be a positive integer.`)
  }

  return value
}

function parseProvider(provider: TomlProviderDefinition): ProviderDefinition {
  const id = readNonEmptyString(provider.id, 'provider id')

  if (provider.type !== 'openai-compatible') {
    throw new Error(
      `Invalid provider "${id}": type must be "openai-compatible".`,
    )
  }

  const endpoint = readNonEmptyString(provider.endpoint, `provider "${id}" endpoint`)

  if (!Array.isArray(provider.models)) {
    throw new TypeError(`Invalid provider "${id}": models must be an array.`)
  }

  const parsedProvider: ProviderDefinition = {
    endpoint,
    id,
    models: provider.models.map(model =>
      parseModel(id, model as TomlSetupModelDefinition),
    ),
    type: provider.type,
  }

  if (provider.headers !== undefined) {
    parsedProvider.headers = readStringMap(
      provider.headers,
      `provider "${id}" headers`,
    )
  }

  return parsedProvider
}

function parseRunner(runner: TomlRunnerConfig): RunnerConfig {
  const parsedRunner: RunnerConfig = {}

  if (runner.cache !== undefined) {
    parsedRunner.cache = parseRunnerCache(runner.cache)
  }

  if (runner.file_concurrency !== undefined) {
    parsedRunner.fileConcurrency = parsePositiveInteger(
      runner.file_concurrency,
      'runner file_concurrency',
    )
  }

  if (runner.rule_concurrency !== undefined) {
    parsedRunner.ruleConcurrency = parsePositiveInteger(
      runner.rule_concurrency,
      'runner rule_concurrency',
    )
  }

  if (runner.stats !== undefined) {
    parsedRunner.stats = parseRunnerStats(runner.stats)
  }

  if (runner.timeout_ms !== undefined) {
    parsedRunner.timeoutMs = parsePositiveInteger(
      runner.timeout_ms,
      'runner timeout_ms',
    )
  }

  return parsedRunner
}

function parseRunnerCache(cache: unknown): RunnerConfig['cache'] {
  if (typeof cache === 'boolean') {
    return cache
  }

  if (!isPlainObject(cache)) {
    throw new TypeError('Invalid runner cache: must be a boolean or table.')
  }

  const tomlCache = cache as TomlRunnerCacheConfig
  const parsedCache: Exclude<RunnerConfig['cache'], boolean | undefined> = {}

  if (tomlCache.enabled !== undefined) {
    if (typeof tomlCache.enabled !== 'boolean') {
      throw new TypeError('Invalid runner cache enabled: must be a boolean.')
    }

    parsedCache.enabled = tomlCache.enabled
  }

  if (tomlCache.location !== undefined) {
    parsedCache.location = readNonEmptyString(
      tomlCache.location,
      'runner cache location',
    )
  }

  return parsedCache
}

function parseRunnerStats(stats: unknown): RunnerConfig['stats'] {
  if (typeof stats === 'boolean') {
    return stats
  }

  if (!isPlainObject(stats)) {
    throw new TypeError('Invalid runner stats: must be a boolean or an object.')
  }

  const tomlStats = stats as TomlRunnerStatsConfig
  const parsedStats: Exclude<RunnerConfig['stats'], boolean | undefined> = {}

  if (tomlStats.enabled !== undefined) {
    if (typeof tomlStats.enabled !== 'boolean') {
      throw new TypeError('Invalid runner stats enabled: must be a boolean.')
    }

    parsedStats.enabled = tomlStats.enabled
  }

  if (tomlStats.location !== undefined) {
    parsedStats.location = readNonEmptyString(
      tomlStats.location,
      'runner stats location',
    )
  }

  if (tomlStats.retention_months !== undefined) {
    parsedStats.retentionMonths = parsePositiveInteger(
      tomlStats.retention_months,
      'runner stats retention_months',
    )
  }

  return parsedStats
}

function readFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`Invalid ${label}: must be a finite number.`)
  }

  return value
}

function readNonEmptyString(value: unknown, label: string): string {
  const stringValue = readString(value, label)

  if (stringValue.length === 0) {
    throw new Error(`Invalid ${label}: must be a non-empty string.`)
  }

  return stringValue
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new Error(`Invalid ${label}: must be a table.`)
  }

  return value as Record<string, unknown>
}

function readString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`Invalid ${label}: must be a string.`)
  }

  return value
}

function readStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    throw new Error(`Invalid ${label}: must be an array of strings.`)
  }

  return value
}

function readStringMap(value: unknown, label: string): Record<string, string> {
  const record = readRecord(value, label)

  if (!Object.values(record).every(item => typeof item === 'string')) {
    throw new Error(`Invalid ${label}: must be a string map.`)
  }

  return record as Record<string, string>
}

function toTomlModel(
  model: SetupModelDefinition,
): StringifiableSetupModelDefinition {
  const tomlModel: StringifiableSetupModelDefinition = {
    id: model.id,
  }

  if (model.name !== undefined) {
    tomlModel.name = model.name
  }

  if (model.aliases !== undefined) {
    tomlModel.aliases = model.aliases
  }

  if (model.capabilities !== undefined) {
    tomlModel.capabilities = model.capabilities
  }

  if (model.size !== undefined) {
    tomlModel.size = model.size
  }

  if (model.contextWindow !== undefined) {
    tomlModel.context_window = model.contextWindow
  }

  if (model.defaultParams !== undefined) {
    tomlModel.default_params = model.defaultParams
  }

  return tomlModel
}

function toTomlProvider(
  provider: ProviderDefinition,
): StringifiableProviderDefinition {
  const tomlProvider: StringifiableProviderDefinition = {
    endpoint: provider.endpoint,
    id: provider.id,
    models: provider.models.map(toTomlModel),
    type: provider.type,
  }

  if (provider.headers !== undefined) {
    tomlProvider.headers = provider.headers
  }

  return tomlProvider
}

function toTomlRunner(runner: RunnerConfig): StringifiableRunnerConfig {
  return {
    cache: toTomlRunnerCache(runner.cache),
    file_concurrency: runner.fileConcurrency,
    rule_concurrency: runner.ruleConcurrency,
    stats: toTomlRunnerStats(runner.stats),
    timeout_ms: runner.timeoutMs,
  }
}

function toTomlRunnerCache(
  cache: RunnerConfig['cache'],
): StringifiableRunnerConfig['cache'] {
  return cache
}

function toTomlRunnerStats(
  stats: RunnerConfig['stats'],
): StringifiableRunnerConfig['stats'] {
  if (stats === undefined || typeof stats === 'boolean') {
    return stats
  }

  const tomlStats: StringifiableRunnerStatsConfig = {
    enabled: stats.enabled,
    location: stats.location,
    retention_months: stats.retentionMonths,
  }

  return tomlStats
}
