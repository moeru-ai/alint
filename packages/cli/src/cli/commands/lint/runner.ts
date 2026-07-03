import type { RunnerConfig, SetupConfig } from '@alint-js/config'
import type { AlintConfig } from '@alint-js/core'

import type { LintCommandOptions } from './options'

import { normalizeConfig } from '@alint-js/core'

export function resolveConfigRunner(config: AlintConfig): RunnerConfig | undefined {
  const runner = normalizeConfig(config).reduce<RunnerConfig | undefined>(
    (merged, item) => item.runner ? { ...merged, ...item.runner } : merged,
    undefined,
  )

  return runner
}

export function resolveRunnerConfig(
  setupConfig: SetupConfig,
  config: { runner?: SetupConfig['runner'] },
  options: LintCommandOptions,
): SetupConfig['runner'] {
  const cache = resolveRunnerCacheConfig(setupConfig.runner?.cache, config.runner?.cache, options)
  const fileConcurrency = parsePositiveIntegerOption(options.fileConcurrency, '--file-concurrency')
  const ruleConcurrency = parsePositiveIntegerOption(options.ruleConcurrency, '--rule-concurrency')
  const timeoutMs = parsePositiveIntegerOption(options.timeoutMs, '--timeout-ms')
  const runner = {
    ...(setupConfig.runner ?? {}),
    ...(config.runner ?? {}),
    cache,
    fileConcurrency: fileConcurrency ?? config.runner?.fileConcurrency ?? setupConfig.runner?.fileConcurrency,
    ruleConcurrency: ruleConcurrency ?? config.runner?.ruleConcurrency ?? setupConfig.runner?.ruleConcurrency,
    timeoutMs: timeoutMs ?? config.runner?.timeoutMs ?? setupConfig.runner?.timeoutMs,
  }

  return Object.values(runner).some(value => value !== undefined)
    ? runner
    : undefined
}

function mergeRunnerCacheConfig(
  setupCache: RunnerConfig['cache'],
  configCache: RunnerConfig['cache'],
): RunnerConfig['cache'] {
  if (configCache === undefined) {
    return setupCache
  }

  if (typeof configCache === 'boolean') {
    return configCache
  }

  if (typeof setupCache === 'object') {
    return { ...setupCache, ...configCache }
  }

  return configCache
}

function parsePositiveIntegerOption(value: string | undefined, label: string): number | undefined {
  if (value === undefined) {
    return undefined
  }

  const parsed = Number(value)

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`)
  }

  return parsed
}

function resolveRunnerCacheConfig(
  setupCache: RunnerConfig['cache'],
  configCache: RunnerConfig['cache'],
  options: LintCommandOptions,
): RunnerConfig['cache'] {
  if (options.cache === false) {
    return false
  }

  const configuredCache = mergeRunnerCacheConfig(setupCache, configCache)

  if (options.cacheLocation !== undefined) {
    return typeof configuredCache === 'object'
      ? { ...configuredCache, location: options.cacheLocation }
      : { location: options.cacheLocation }
  }

  return configuredCache
}
