import type {
  AlintConfig,
  ProgressReporter,
  RunnerConfig,
  RunResult,
  SetupConfig,
} from '@alint-js/core'

import type { CliIo } from '../types'

import { loadAlintConfig } from '@alint-js/config'
import { runAlint } from '@alint-js/core'

import { loadRunSetupConfig } from '../commands/config/setup-config'
import { findLintTargets } from '../commands/lint/discovery'
import { startModelAdapters } from './model-adapter'
import { mergeRunnerConfigs, resolveConfigRunner } from './runner'

export interface CreateRunSessionOptions {
  configPath?: string
  /** Spawns ACP processes and binds a loopback port. Replace it to keep a session offline. */
  startModelAdapters?: typeof startModelAdapters
}

export interface RunSession {
  config: AlintConfig
  cwd: string
  defaultModel?: string
  run: (options: SessionRunOptions) => Promise<RunResult>
  /** Setup config merged with project config. No CLI flag is applied. */
  runner?: RunnerConfig
  setupConfig: SetupConfig
  shutdown: () => Promise<void>
}

export interface SessionRunOptions {
  cacheOnly?: boolean
  files?: string[]
  modelOverride?: string
  outputLanguage?: string
  progress?: ProgressReporter
  projectTargets?: boolean
  runner?: RunnerConfig
  signal?: AbortSignal
}

/**
 * Loads config, setup config, and model adapters once, then runs any number of times.
 *
 * The lint command and the language server both use this function. A second implementation would
 * resolve config or cwd differently, and the editor would then read a different cache file.
 */
export async function createRunSession(
  io: CliIo,
  options: CreateRunSessionOptions = {},
): Promise<RunSession> {
  const [{ defaultModel, setupConfig: fileSetupConfig }, config] = await Promise.all([
    loadRunSetupConfig(io),
    loadAlintConfig(io.cwd, options.configPath),
  ])
  const startAdapters = options.startModelAdapters ?? startModelAdapters
  const runtime = await startAdapters(fileSetupConfig, io)

  // core hashes setupConfig into modelHash, and normalization can embed a per-process ACP port.
  // Normalize once, or each run gets a different cache key.
  const { setupConfig } = runtime
  let shutdown: Promise<void> | undefined

  return {
    config,
    cwd: io.cwd,
    defaultModel,
    run: async (runOptions) => {
      const targets = await findLintTargets({
        config,
        cwd: io.cwd,
        errorOnUnmatchedPattern: true,
        globInputPaths: true,
        inputs: runOptions.files ?? [],
      })

      return runAlint({
        cacheOnly: runOptions.cacheOnly,
        config,
        cwd: io.cwd,
        defaultModel,
        directories: targets.directories,
        files: targets.files,
        modelOverride: runOptions.modelOverride,
        outputLanguage: runOptions.outputLanguage,
        progress: runOptions.progress,
        projectTargets: runOptions.projectTargets,
        runner: runOptions.runner,
        setupConfig,
        signal: runOptions.signal,
      })
    },
    runner: mergeRunnerConfigs(setupConfig.runner, resolveConfigRunner(config)),
    setupConfig,
    // Two owners can dispose the same session. Shut the gateway down only once.
    shutdown: () => shutdown ??= runtime.shutdown(),
  }
}
