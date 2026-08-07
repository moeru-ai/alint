import type { StopGateEnvelope } from './types'

import { executeStopGate, probeStopGateConfig, startupTimeoutMs } from './protocol'
import { resolveCommands } from './resolve-command'

export interface ResolvedAlintStopGate {
  enabled: boolean
  run: (sessionId: string) => Promise<StopGateEnvelope>
  target: 'all' | 'dirty-files'
}

export async function resolveAlintStopGate(
  gitRoot: string,
): Promise<ResolvedAlintStopGate> {
  const commands = await resolveCommands(gitRoot)
  const startupDeadline = Date.now() + startupTimeoutMs

  for (const command of commands) {
    const config = await probeStopGateConfig(command, gitRoot, startupDeadline)

    if (config === undefined) {
      continue
    }

    return {
      enabled: config.enabled,
      run: sessionId => executeStopGate(command, gitRoot, sessionId, config.timeoutMs),
      target: config.target,
    }
  }

  throw new Error([
    'Could not find an alint CLI that supports `integrations stop-gate`.',
    'Ask the user for approval before installing or updating @alint-js/cli in this repository.',
  ].join(' '))
}
