import type { RunResult } from '@alint-js/core'

import type { ReporterName } from '../../reporters'
import type { CliIo, CliWritable } from '../../types'
import type { LintCommandOptions } from './options'

import { stat } from 'node:fs/promises'

import { loadAlintConfig } from '@alint-js/config'
import { AlintRunCancelledError, AlintRunError } from '@alint-js/core'
import { resolve } from 'pathe'

import { findGitRoot } from '../../git'
import { formatDiagnostics } from '../../reporters'
import { createCliProgressReporter } from '../../reporters/progress'
import { defineCommand } from '../command'
import { findDirtyLintTargets, findLintTargets, NoFilesFoundError } from './discovery'
import { formatCancelledError, formatRunError } from './errors'
import { executeLint } from './execution'

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
  options: [
    { description: 'Lint only staged, unstaged, and untracked files', flags: '--dirty' },
  ],
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
  if (options.dirty && files.length > 0) {
    io.stderr.write('The --dirty option does not accept file arguments.\n')
    return 2
  }

  const cwd = options.dirty ? await findGitRoot(io.cwd) : io.cwd
  const runIo = cwd === io.cwd ? io : { ...io, cwd }

  if (options.config) {
    await assertConfigExists(cwd, options.config)
  }

  const config = await loadAlintConfig(cwd, options.config)
  let lintTargets: Awaited<ReturnType<typeof findLintTargets>>

  try {
    lintTargets = options.dirty
      ? await findDirtyLintTargets(config, cwd)
      : await findLintTargets({
          config,
          cwd,
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

  if (options.dirty && lintTargets.files.length === 0) {
    return 0
  }

  const progress = shouldEnableProgress(options, runIo)
    ? createCliProgressReporter({
        color: runIo.stderr.isTTY === true,
        columns: runIo.stderr.columns ?? 80,
        cwd,
        isTty: runIo.stderr.isTTY === true,
        rows: runIo.stderr.rows,
        write: chunk => runIo.stderr.write(chunk),
      })
    : undefined
  const restoreProgressConsole = progress
    ? interceptConsoleOutput({ write: progress.write })
    : undefined
  const writeResult = (runResult: RunResult): void => {
    runIo.stdout.write(formatDiagnostics(options.format as ReporterName, runResult, {
      color: runIo.stdout.isTTY === true,
    }))
  }
  let result: RunResult

  try {
    // TODO: (cli-sigint) Wire SIGINT to RunOptions.signal after the CLI lifecycle owner approves process-level cancellation handling; core cancellation is already available.
    result = await executeLint({
      cacheOnly: options.cacheOnly,
      config,
      cwd,
      directories: lintTargets.directories,
      files: lintTargets.files,
      io: runIo,
      modelOverride: options.model,
      outputLanguage: options.outputLanguage,
      progress: progress?.reporter,
      runnerOptions: options,
    })
  }
  catch (error) {
    if (error instanceof AlintRunError) {
      writeResult(error.result)
      runIo.stderr.write(formatRunError(error, runIo.stderr.isTTY === true))
      return 2
    }

    if (error instanceof AlintRunCancelledError) {
      writeResult(error.result)
      runIo.stderr.write(formatCancelledError(error, runIo.stderr.isTTY === true))
      return 2
    }

    throw error
  }
  finally {
    restoreProgressConsole?.()
    progress?.dispose()
  }

  writeResult(result)
  return result.diagnostics.some(diagnostic => diagnostic.severity === 'error') ? 1 : 0
}

function shouldEnableProgress(options: LintCommandOptions, io: CliIo): boolean {
  if (options.progress !== undefined)
    return options.progress

  return options.format === 'stylish' && io.stderr.isTTY === true
}
