import type { AlintConfig, ResolvedStopGateConfig, RunResult } from '@alint-js/core'

import type { CliIo } from '../../../types'

import { AlintRunError } from '@alint-js/core'

import { createRunSession } from '../../../runtime/session'
import { filterResultToChangedLines } from '../../lint/changed-lines'
import { findDirtyLintTargets, findLintTargets } from '../../lint/discovery'
import { executeLint } from '../../lint/execution'
import { createTimeoutSignal } from './timeout'

export interface StopGateLintResult {
  error?: AlintRunError
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

  const session = await createRunSession({ ...options.io, cwd: options.cwd }, { config: options.config })
  let timeout: ReturnType<typeof createTimeoutSignal> | undefined

  try {
    let result: RunResult
    let runError: AlintRunError | undefined

    try {
      result = await executeLint({
        createSignal: () => {
          // The configured budget covers lint execution, not setup-config and runner resolution.
          timeout = createTimeoutSignal(options.stopGate.timeoutMs)
          return timeout.signal
        },
        io: options.io,
        runnerOptions: { format: 'json' },
        session,
        targets,
      })
    }
    catch (error) {
      if (!(error instanceof AlintRunError)) {
        throw error
      }

      runError = error
      result = error.result
    }

    if (dirtyTargets !== undefined) {
      result = filterResultToChangedLines(result, {
        changedLines: dirtyTargets.changedLines,
        cwd: options.cwd,
      })
    }

    return runError === undefined
      ? { files: targets.files, result }
      : { error: runError, files: targets.files, result }
  }
  finally {
    timeout?.dispose()
    await session.shutdown()
  }
}
