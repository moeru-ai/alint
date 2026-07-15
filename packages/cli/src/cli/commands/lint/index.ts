import type { ReporterName } from '../../reporters'
import type { CliIo, CliWritable } from '../../types'
import type { LintCommandOptions } from './options'

import { stat } from 'node:fs/promises'

import { loadAlintConfig } from '@alint-js/config'
import { AlintProgressError, AlintRunCancelledError, AlintRunError, runAlint } from '@alint-js/core'
import { resolve } from 'pathe'

import { formatDiagnostics } from '../../reporters'
import { createCliProgressReporter } from '../../reporters/progress'
import { defineCommand } from '../command'
import { loadMergedSetupConfig } from '../config/setup-config'
import { findLintTargets, NoFilesFoundError } from './discovery'
import { formatCancelledError, formatRunError } from './errors'
import { resolveConfigRunner, resolveRunnerConfig } from './runner'
import { createStatsCollector, mergeProgressReporters, resolveStatsWrite, writeRunStats } from './stats'

export const lint = defineCommand({
  action: (context, files: string[] = [], options: LintCommandOptions) =>
    runLintCommand(
      files,
      {
        ...options,
        outputLanguage: options.lang ?? context.globalOptions.outputLanguage,
      },
      context.io,
      context.interceptConsoleOutput,
    ),
  alias: ['!'],
  arguments: '[...files]',
  default: true,
  description: 'Run alint',
  name: 'lint',
})

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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

async function runLintCommand(
  files: string[],
  options: LintCommandOptions,
  io: CliIo,
  interceptConsoleOutput: (stdout: CliWritable) => () => void,
): Promise<number> {
  if (options.config) {
    await assertConfigExists(io.cwd, options.config)
  }

  const [setupConfig, config] = await Promise.all([
    loadMergedSetupConfig(io),
    loadAlintConfig(io.cwd, options.config),
  ])
  let lintTargets: Awaited<ReturnType<typeof findLintTargets>>

  try {
    lintTargets = await findLintTargets({
      config,
      cwd: io.cwd,
      errorOnUnmatchedPattern: true,
      globInputPaths: true,
      inputs: files,
    })
  }
  catch (error) {
    if (error instanceof NoFilesFoundError) {
      io.stderr.write(`${error.message}\n`)
      return 2
    }

    throw error
  }

  const runner = resolveRunnerConfig(setupConfig, { runner: resolveConfigRunner(config) }, options)
  const progress = shouldEnableProgress(options, io)
    ? createCliProgressReporter({
        color: io.stderr.isTTY === true,
        columns: io.stderr.columns ?? 80,
        cwd: io.cwd,
        isTty: io.stderr.isTTY === true,
        rows: io.stderr.rows,
        write: chunk => io.stderr.write(chunk),
      })
    : undefined
  const restoreProgressConsole = progress
    ? interceptConsoleOutput({ write: progress.write })
    : undefined
  const statsTarget = resolveStatsWrite(runner?.stats, io.env)
  const statsCollector = statsTarget ? createStatsCollector() : undefined
  const persistStats = async (runResult: Awaited<ReturnType<typeof runAlint>>): Promise<void> => {
    if (statsTarget && statsCollector)
      await writeRunStats(statsTarget, statsCollector, runResult, io.cwd)
  }
  let result: Awaited<ReturnType<typeof runAlint>>

  try {
    // TODO: (cli-sigint) Wire SIGINT to RunOptions.signal after the CLI lifecycle owner approves process-level cancellation handling; core cancellation is already available.
    result = await runAlint({
      config,
      cwd: io.cwd,
      directories: lintTargets.directories,
      files: lintTargets.files,
      modelOverride: options.model,
      outputLanguage: options.outputLanguage,
      progress: mergeProgressReporters(progress?.reporter, statsCollector?.reporter),
      runner,
      setupConfig,
    })
  }
  catch (error) {
    restoreProgressConsole?.()
    progress?.dispose()

    if (error instanceof AlintProgressError || error instanceof AlintRunError) {
      await persistStats(error.result)
      io.stderr.write(formatRunError(error, io.stderr.isTTY === true))
      return 2
    }

    if (error instanceof AlintRunCancelledError) {
      await persistStats(error.result)
      io.stderr.write(formatCancelledError(error, io.stderr.isTTY === true))
      return 2
    }

    throw error
  }

  restoreProgressConsole?.()
  progress?.dispose()

  await persistStats(result)

  io.stdout.write(formatDiagnostics(options.format as ReporterName, result, {
    color: io.stdout.isTTY === true,
  }))
  return result.diagnostics.some(diagnostic => diagnostic.severity === 'error') ? 1 : 0
}

function shouldEnableProgress(options: LintCommandOptions, io: CliIo): boolean {
  if (options.progress !== undefined)
    return options.progress

  return options.format === 'stylish' && io.stderr.isTTY === true
}
