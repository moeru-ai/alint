import type { RunResult } from '@alint-js/core'

import type { ReporterName } from '../../reporters'
import type { RunSession } from '../../runtime/session'
import type { CliIo, CliWritable } from '../../types'
import type { LintCommandOptions } from './options'

import { stat } from 'node:fs/promises'

import { DEFAULT_TRACING_DIRECTORY } from '@alint-js/config'
import { AlintRunCancelledError, AlintRunError } from '@alint-js/core'
import { resolve } from 'pathe'

import { formatDiagnostics } from '../../reporters'
import { createCliProgressReporter } from '../../reporters/progress'
import { createRunSession } from '../../runtime/session'
import { defineCommand } from '../command'
import { NoFilesFoundError } from './discovery'
import { formatCancelledError, formatRunError } from './errors'
import { resolveRunnerConfig } from './runner'
import { createStatsCollector, mergeProgressReporters, resolveStatsWrite, writeRunStats } from './stats'
import { runWithTracing } from './tracing'

export const lint = defineCommand({
  action: (context, files: string[] = [], options: LintCommandOptions) => runLintCommand(files, {
    ...options,
    outputLanguage: options.lang ?? context.globalOptions.outputLanguage,
  }, context.io, context.interceptConsoleOutput),
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
    if (!stats.isFile())
      throw new Error(`Config file "${configPath}" is not a file.`)
  }
  catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT')
      throw new Error(`Config file "${configPath}" does not exist.`)
    throw error
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

async function runConfiguredLintCommand(
  files: string[],
  options: LintCommandOptions,
  io: CliIo,
  interceptConsoleOutput: (stdout: CliWritable) => () => void,
  session: RunSession,
  tracingReporter?: Parameters<typeof mergeProgressReporters>[0],
): Promise<number> {
  const runner = resolveRunnerConfig(session.runner, options)
  const progress = shouldEnableProgress(options, io)
    ? createCliProgressReporter({ color: io.stderr.isTTY === true, columns: io.stderr.columns ?? 80, cwd: io.cwd, isTty: io.stderr.isTTY === true, rows: io.stderr.rows, write: chunk => io.stderr.write(chunk) })
    : undefined
  const restoreProgressConsole = progress ? interceptConsoleOutput({ write: progress.write }) : undefined
  const statsTarget = resolveStatsWrite(runner?.stats, io.env)
  const statsCollector = statsTarget ? createStatsCollector() : undefined
  const persistStats = async (runResult: RunResult): Promise<void> => {
    if (statsTarget && statsCollector)
      await writeRunStats(statsTarget, statsCollector, runResult, io.cwd)
  }
  const writeResult = (runResult: RunResult): void => {
    io.stdout.write(formatDiagnostics(options.format as ReporterName, runResult, { color: io.stdout.isTTY === true }))
  }
  let result: RunResult
  try {
    result = await session.run({
      cacheOnly: options.cacheOnly,
      files,
      modelOverride: options.model,
      outputLanguage: options.outputLanguage,
      progress: mergeProgressReporters(mergeProgressReporters(progress?.reporter, statsCollector?.reporter), tracingReporter),
      runner,
    })
  }
  catch (error) {
    restoreProgressConsole?.()
    progress?.dispose()
    if (error instanceof NoFilesFoundError) {
      io.stderr.write(`${error.message}\n`)
      return 2
    }
    if (error instanceof AlintRunError) {
      await persistStats(error.result)
      writeResult(error.result)
      io.stderr.write(formatRunError(error, io.stderr.isTTY === true))
      return 2
    }
    if (error instanceof AlintRunCancelledError) {
      await persistStats(error.result)
      writeResult(error.result)
      io.stderr.write(formatCancelledError(error, io.stderr.isTTY === true))
      return 2
    }
    throw error
  }
  restoreProgressConsole?.()
  progress?.dispose()
  await persistStats(result)
  writeResult(result)
  return result.diagnostics.some(diagnostic => diagnostic.severity === 'error') ? 1 : 0
}

async function runLintCommand(files: string[], options: LintCommandOptions, io: CliIo, interceptConsoleOutput: (stdout: CliWritable) => () => void): Promise<number> {
  if (options.config)
    await assertConfigExists(io.cwd, options.config)
  const session = await createRunSession(io, { configPath: options.config })
  try {
    if (session.tracing?.enabled !== true)
      return await runConfiguredLintCommand(files, options, io, interceptConsoleOutput, session)
    return await runWithTracing({
      captureLlmContent: session.tracing.captureLlmContent === true,
      cwd: io.cwd,
      directory: session.tracing.directory ?? DEFAULT_TRACING_DIRECTORY,
      files,
    }, reporter => runConfiguredLintCommand(files, options, io, interceptConsoleOutput, session, reporter))
  }
  finally {
    await session.shutdown()
  }
}

function shouldEnableProgress(options: LintCommandOptions, io: CliIo): boolean {
  if (options.progress !== undefined)
    return options.progress
  return options.format === 'stylish' && io.stderr.isTTY === true
}
