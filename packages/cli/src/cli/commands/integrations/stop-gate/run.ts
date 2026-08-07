import type { AlintConfig, ResolvedStopGateConfig, RunResult } from '@alint-js/core'

import type { CliIo } from '../../../types'

import { filterResultToChangedLines } from '../../lint/changed-lines'
import { findDirtyLintTargets, findLintTargets } from '../../lint/discovery'
import { executeLint } from '../../lint/execution'
import { createTimeoutSignal } from './timeout'

export interface StopGateLintResult {
  files: string[]
  result: RunResult
}

export async function runStopGateLint(options: {
  config: AlintConfig
  cwd: string
  io: CliIo
  stopGate: ResolvedStopGateConfig
}): Promise<StopGateLintResult | undefined> {
  const dirtyTargets = options.stopGate.target === 'dirty-files'
    ? await findDirtyLintTargets(options.config, options.cwd)
    : undefined
  const targets = dirtyTargets
    ?? await findLintTargets({
      config: options.config,
      cwd: options.cwd,
      errorOnUnmatchedPattern: true,
      globInputPaths: true,
      inputs: ['.'],
    })

  if (
    options.stopGate.target === 'dirty-files'
    && targets.files.length === 0
  ) {
    return undefined
  }

  let timeout: ReturnType<typeof createTimeoutSignal> | undefined

  try {
    let result = await executeLint({
      config: options.config,
      createSignal: () => {
        // The configured budget covers lint execution, not setup-config and runner resolution.
        timeout = createTimeoutSignal(options.stopGate.timeoutMs)
        return timeout.signal
      },
      cwd: options.cwd,
      directories: targets.directories,
      files: targets.files,
      io: options.io,
      runnerOptions: { format: 'json' },
    })

    if (dirtyTargets !== undefined) {
      result = filterResultToChangedLines(result, {
        changedLines: dirtyTargets.changedLines,
        cwd: options.cwd,
      })
    }

    return { files: targets.files, result }
  }
  finally {
    timeout?.dispose()
  }
}
