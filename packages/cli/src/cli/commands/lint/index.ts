import type { ReporterName } from '../../reporters'
import type { CliIo, CliWritable } from '../../types'
import type { LintCommandOptions } from './options'

import { stat } from 'node:fs/promises'

import { loadAlintConfig } from '@alint-js/config'
import { AlintRunError, runAlint } from '@alint-js/core'
import { resolve } from 'pathe'

import { formatDiagnostics } from '../../reporters'
import { createCliProgressReporter } from '../../reporters/progress'
import { defineCommand } from '../command'
import { loadMergedSetupConfig } from '../config/setup-config'
import { resolveLintFiles } from './discovery'
import { formatRunError } from './errors'
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
  const lintFiles = await resolveLintFiles(files, config, io.cwd)
  const runner = resolveRunnerConfig(setupConfig, { runner: resolveConfigRunner(config) }, options)
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
  const statsTarget = resolveStatsWrite(runner?.stats, io.env)
  const statsCollector = statsTarget ? createStatsCollector() : undefined
  let result: Awaited<ReturnType<typeof runAlint>>

  try {
    result = await runAlint({
      config,
      cwd: io.cwd,
      files: lintFiles,
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

    if (error instanceof AlintRunError) {
      io.stderr.write(formatRunError(error, io.stderr.isTTY === true))
      return 2
    }

    throw error
  }

  restoreProgressConsole?.()
  progress?.dispose()

  if (statsTarget && statsCollector) {
    await writeRunStats(statsTarget, statsCollector, result, io.cwd)
  }

  io.stdout.write(formatDiagnostics(options.format as ReporterName, result, {
    color: io.stdout.isTTY === true,
  }))
  return result.diagnostics.length > 0 ? 1 : 0
}

function shouldEnableProgress(options: LintCommandOptions, io: CliIo): boolean {
  if (options.progress !== undefined)
    return options.progress

  return options.format === 'stylish' && io.stderr.isTTY === true
}
