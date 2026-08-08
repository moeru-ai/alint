import type { AlintConfig, ProgressReporter, RunResult } from '@alint-js/core'

import type { CliIo } from '../../types'
import type { LintCommandOptions } from './options'

import { AlintCachePersistenceError, AlintRunCancelledError, AlintRunError, runAlint } from '@alint-js/core'

import { loadRunSetupConfig } from '../config/setup-config'
import { resolveConfigRunner, resolveRunnerConfig } from './runner'
import { createStatsCollector, mergeProgressReporters, resolveStatsWrite, writeRunStats } from './stats'

export interface LintExecutionOptions {
  cacheOnly?: boolean
  config: AlintConfig
  createSignal?: () => AbortSignal
  cwd: string
  directories: string[]
  files: string[]
  io: CliIo
  modelOverride?: string
  outputLanguage?: string
  progress?: ProgressReporter
  runnerOptions: LintCommandOptions
}

/** Runs resolved lint targets while keeping runner resolution and stats persistence consistent. */
export async function executeLint(options: LintExecutionOptions): Promise<RunResult> {
  const { defaultModel, setupConfig } = await loadRunSetupConfig({ ...options.io, cwd: options.cwd })
  const runner = resolveRunnerConfig(
    setupConfig,
    { runner: resolveConfigRunner(options.config) },
    options.runnerOptions,
  )
  const statsTarget = resolveStatsWrite(runner?.stats, options.io.env)
  const statsCollector = statsTarget ? createStatsCollector() : undefined
  const persistStats = async (result: RunResult): Promise<void> => {
    if (statsTarget && statsCollector) {
      await writeRunStats(statsTarget, statsCollector, result, options.cwd)
    }
  }
  let result: RunResult

  try {
    result = await runAlint({
      cacheOnly: options.cacheOnly,
      config: options.config,
      cwd: options.cwd,
      defaultModel,
      directories: options.directories,
      files: options.files,
      modelOverride: options.modelOverride,
      outputLanguage: options.outputLanguage,
      progress: mergeProgressReporters(options.progress, statsCollector?.reporter),
      runner,
      setupConfig,
      signal: options.createSignal?.(),
    })
  }
  catch (error) {
    if (error instanceof AlintRunError || error instanceof AlintRunCancelledError || error instanceof AlintCachePersistenceError) {
      await persistStats(error.result)
    }

    throw error
  }

  await persistStats(result)
  return result
}
