import type { CommandContext } from '../../command'

import { enableTracing, writeSetupConfig } from '@alint-js/config'

import { escapeLineValue } from '../../../output'
import { defineCommand } from '../../command'
import { loadScopedSetupConfig } from '../setup-config'

export interface EnableTracingOptions {
  directory?: string | string[]
  local?: boolean
}

export const enable = defineCommand({
  action: runEnableTracingCommand,
  description: 'Enable tracing and configure its output directory',
  name: 'enable',
  options: [
    { description: 'Directory for OTLP trace files', flags: '--directory <path>' },
    { description: 'Read and write project-local config', flags: '--local' },
  ],
})

async function runEnableTracingCommand(
  context: CommandContext,
  options: EnableTracingOptions,
): Promise<number> {
  if (Array.isArray(options.directory)) {
    context.io.stderr.write('config tracing enable accepts --directory only once.\n')
    return 2
  }

  if (options.directory === '') {
    context.io.stderr.write('config tracing enable requires a non-empty --directory value.\n')
    return 2
  }

  const { config, path, scope } = await loadScopedSetupConfig(context.io, options.local)
  const nextConfig = enableTracing(config, options.directory)

  await writeSetupConfig(path, nextConfig)
  context.io.stdout.write([
    'enabled: true',
    `directory: ${escapeLineValue(nextConfig.tracing.directory)}`,
    `scope: ${scope}`,
    '',
  ].join('\n'))
  return 0
}
