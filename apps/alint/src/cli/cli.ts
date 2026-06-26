import type { InspectOptions } from 'node:util'

import type { RunnerConfig, SetupConfig } from '../config/types'
import type { ReporterName } from './reporters'

import process from 'node:process'

import { stat } from 'node:fs/promises'
import { inspect } from 'node:util'

import c from 'tinyrainbow'

import { cac } from 'cac'
import { resolve } from 'pathe'

import { loadAlintConfig } from '../config/load-config'
import { getGlobalSetupConfigPath, getProjectSetupConfigPath } from '../config/paths'
import { loadSetupConfig, mergeSetupConfigs } from '../config/setup-load'
import { writeSetupConfig } from '../config/setup-write'
import { AlintRunError, runAlint } from '../core/run'
import { formatDiagnostics } from './reporters'
import { createCliProgressReporter } from './reporters/progress'

export interface CliIo {
  cwd: string
  env?: NodeJS.ProcessEnv
  stderr: CliWritable
  stdout: CliWritable
}

interface CliWritable {
  columns?: number
  isTTY?: boolean
  write: (chunk: string) => unknown
}

interface GlobalCliOptions {
  cache?: boolean
  cacheLocation?: string
  config?: string
  fileConcurrency?: string
  format: string
  model?: string
  progress?: boolean
  ruleConcurrency?: string
  timeoutMs?: string
}

interface SetupCliOptions extends GlobalCliOptions {
  local?: boolean
  noInteractive?: boolean
  providerEndpoint?: string
  providerHeader?: string | string[]
  providerModel?: string | string[]
}

export async function executeCli(argv: string[], io: CliIo): Promise<number> {
  const cli = cac('alint')
  const setupNoInteractive = argv.includes('-N') || argv.includes('--no-interactive')
  let pendingResult: Promise<number> | undefined

  cli
    .option('--no-cache', 'Disable cache for this run')
    .option('--cache-location <path>', 'Path to the alint cache file or directory')
    .option('--config <path>', 'Path to alint config file')
    .option('--file-concurrency <count>', 'Number of files to lint concurrently')
    .option('--format <format>', 'Reporter format', { default: 'stylish' })
    .option('--model <model>', 'Force a model override')
    .option('--progress', 'Show run progress')
    .option('--rule-concurrency <count>', 'Number of rules to run concurrently within a file')
    .option('--timeout-ms <ms>', 'Rule execution timeout in milliseconds')
    .help()

  cli
    .command('setup', 'Write alint provider configuration')
    .option('--local', 'Write project-local config')
    .option('-N, --no-interactive', 'Disable interactive setup')
    .option('--provider-endpoint <endpoint>', 'Provider endpoint')
    .option('--provider-model <model>', 'Provider model')
    .option('--provider-header <Key=Value>', 'Provider header')
    .action((options: SetupCliOptions) => {
      pendingResult = runSetupCommand({
        ...options,
        noInteractive: setupNoInteractive,
      }, io)
      return pendingResult
    })

  cli
    .command('[...files]', 'Run alint')
    .action((files: string[] = [], options: GlobalCliOptions) => {
      pendingResult = runDefaultCommand(files, options, io)
      return pendingResult
    })

  const restoreConsole = interceptConsoleOutput(shouldCaptureHelp(argv) ? io.stdout : io.stderr)

  try {
    cli.parse(argv)
    return await (pendingResult ?? Promise.resolve(0))
  }
  finally {
    restoreConsole()
  }
}

async function assertConfigExists(cwd: string, configPath: string): Promise<void> {
  const resolvedConfigPath = resolve(cwd, configPath)

  try {
    const stats = await stat(resolvedConfigPath)

    if (!stats.isFile()) {
      throw new Error(`Config file "${configPath}" is not a file.`)
    }
  }
  catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new Error(`Config file "${configPath}" does not exist.`)
    }

    throw error
  }
}

function createSetupConfig(
  providerEndpoint: string,
  options: SetupCliOptions,
): SetupConfig {
  const models = toArray(options.providerModel).map(model => ({
    id: model,
    name: model,
  }))
  const headers = parseHeaders(toArray(options.providerHeader))

  return {
    providers: [
      {
        endpoint: providerEndpoint,
        headers,
        id: providerEndpoint,
        models,
        type: 'openai-compatible',
      },
    ],
    version: 1,
  }
}

function formatRunError(error: AlintRunError, color: boolean): string {
  const label = color ? c.red('error') : 'error'
  const context = formatRunErrorContext(error)
  const message = error.failure?.message ?? error.message

  return `${label} ${context}\n  Rule running failed due to ${message}\n`
}

function formatRunErrorContext(error: AlintRunError): string {
  const failure = error.failure

  if (!failure) {
    return 'alint run failed'
  }

  const target = failure.target
    ? failure.target.name
      ? `${failure.target.kind} ${failure.target.name}`
      : failure.target.kind
    : undefined

  return [
    failure.filePath,
    target,
    failure.ruleId,
  ].filter(Boolean).join(' > ')
}

function interceptConsoleOutput(stdout: CliWritable): () => void {
  const cliConsole = globalThis.console
  const originalConsoleDebug = cliConsole.debug
  const originalConsoleDir = cliConsole.dir
  const originalConsoleInfo = console.info
  const originalConsoleLog = cliConsole.log

  const writeConsoleLine = (...args: unknown[]) => {
    stdout.write(`${args.map(String).join(' ')}\n`)
  }
  const writeConsoleDir = (item?: unknown, options?: InspectOptions) => {
    stdout.write(`${inspect(item, options)}\n`)
  }

  cliConsole.debug = writeConsoleLine
  cliConsole.dir = writeConsoleDir
  console.info = writeConsoleLine
  cliConsole.log = writeConsoleLine

  return () => {
    cliConsole.debug = originalConsoleDebug
    cliConsole.dir = originalConsoleDir
    console.info = originalConsoleInfo
    cliConsole.log = originalConsoleLog
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function isNoInteractive(options: SetupCliOptions): boolean {
  return options.noInteractive === true
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

function parseHeaders(headers: string[]): Record<string, string> | undefined {
  if (headers.length === 0) {
    return undefined
  }

  const parsedHeaders: Record<string, string> = {}

  for (const header of headers) {
    const separatorIndex = header.indexOf('=')

    if (separatorIndex <= 0) {
      throw new Error(`Invalid provider header "${header}". Expected Key=Value.`)
    }

    parsedHeaders[header.slice(0, separatorIndex)] = header.slice(separatorIndex + 1)
  }

  return parsedHeaders
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
  options: GlobalCliOptions,
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

function resolveRunnerConfig(
  setupConfig: SetupConfig,
  config: { runner?: SetupConfig['runner'] },
  options: GlobalCliOptions,
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

async function runDefaultCommand(
  files: string[],
  options: GlobalCliOptions,
  io: CliIo,
): Promise<number> {
  if (options.config) {
    await assertConfigExists(io.cwd, options.config)
  }

  const globalSetupConfigPath = getGlobalSetupConfigPath(io.env ?? process.env)
  const projectSetupConfigPath = getProjectSetupConfigPath(io.cwd)
  const [globalSetupConfig, projectSetupConfig, config] = await Promise.all([
    loadSetupConfig(globalSetupConfigPath),
    loadSetupConfig(projectSetupConfigPath),
    loadAlintConfig(io.cwd, options.config),
  ])
  const setupConfig = mergeSetupConfigs(globalSetupConfig, projectSetupConfig)
  const runner = resolveRunnerConfig(setupConfig, config, options)
  const progress = shouldEnableProgress(options, io)
    ? createCliProgressReporter({
        color: io.stderr.isTTY === true,
        columns: io.stderr.columns ?? 80,
        cwd: io.cwd,
        isTty: io.stderr.isTTY === true,
        write: chunk => io.stderr.write(chunk),
      })
    : undefined
  const restoreProgressConsole = progress
    ? interceptConsoleOutput({ write: progress.write })
    : undefined
  let result: Awaited<ReturnType<typeof runAlint>>

  try {
    result = await runAlint({
      config,
      cwd: io.cwd,
      files,
      modelOverride: options.model,
      progress: progress?.reporter,
      runner,
      setupConfig,
    })
  }
  catch (error) {
    restoreProgressConsole?.()
    progress?.dispose()

    if (error instanceof AlintRunError) {
      io.stderr.write(formatRunError(error, io.stderr.isTTY === true))
      return 2
    }

    throw error
  }

  restoreProgressConsole?.()
  progress?.dispose()

  io.stdout.write(formatDiagnostics(options.format as ReporterName, result, {
    color: io.stdout.isTTY === true,
  }))
  return result.diagnostics.length > 0 ? 1 : 0
}

async function runSetupCommand(
  options: SetupCliOptions,
  io: CliIo,
): Promise<number> {
  if (!options.providerEndpoint) {
    if (!isNoInteractive(options)) {
      io.stderr.write('interactive setup is not implemented yet. Use -N/--no-interactive with --provider-endpoint.\n')
      return 2
    }

    io.stderr.write('setup requires --provider-endpoint in --no-interactive mode.\n')
    return 2
  }

  const setupConfigPath = options.local
    ? getProjectSetupConfigPath(io.cwd)
    : getGlobalSetupConfigPath(io.env ?? process.env)
  const existingConfig = await loadSetupConfig(setupConfigPath)
  const nextConfig = mergeSetupConfigs(
    existingConfig,
    createSetupConfig(options.providerEndpoint, options),
  )

  await writeSetupConfig(setupConfigPath, nextConfig)
  return 0
}

function shouldCaptureHelp(argv: string[]): boolean {
  return argv.includes('--help') || argv.includes('-h')
}

function shouldEnableProgress(options: GlobalCliOptions, io: CliIo): boolean {
  if (options.progress !== undefined)
    return options.progress

  return options.format === 'stylish' && io.stderr.isTTY === true
}

function toArray(value: string | string[] | undefined): string[] {
  if (value === undefined) {
    return []
  }

  return (Array.isArray(value) ? value : [value]).filter(
    (item): item is string => typeof item === 'string',
  )
}
