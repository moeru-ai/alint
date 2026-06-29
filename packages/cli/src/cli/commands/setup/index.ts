import type { SetupConfig } from '@alint-js/config'

import process from 'node:process'

import { getGlobalSetupConfigPath, getProjectSetupConfigPath, loadSetupConfig, mergeSetupConfigs, writeSetupConfig } from '@alint-js/config'

import { parseHeaderList } from '../../provider-registry'
import { runInteractiveSetup } from './interactive'

export interface SetupCommandIo {
  cwd: string
  env?: NodeJS.ProcessEnv
  stderr: { isTTY?: boolean, write: (chunk: string) => unknown }
  stdin?: { isTTY?: boolean }
  stdout: { isTTY?: boolean, write: (chunk: string) => unknown }
}

export interface SetupCommandOptions {
  local?: boolean
  noInteractive?: boolean
  providerEndpoint?: string
  providerHeader?: string | string[]
  providerId?: string
  providerModel?: string | string[]
}

export async function runSetupCommand(
  options: SetupCommandOptions,
  io: SetupCommandIo,
): Promise<number> {
  if (!options.providerEndpoint) {
    if (options.noInteractive !== true) {
      return runInteractiveSetup({ ...io, stdin: io.stdin ?? process.stdin })
    }

    io.stderr.write('setup requires --provider-endpoint in --no-interactive mode.\n')
    return 2
  }

  if (!options.providerId) {
    io.stderr.write('setup requires --provider-id in --no-interactive mode.\n')
    return 2
  }

  const setupConfigPath = options.local
    ? getProjectSetupConfigPath(io.cwd)
    : getGlobalSetupConfigPath(io.env ?? process.env)
  const existingConfig = await loadSetupConfig(setupConfigPath)
  const nextConfig = mergeSetupConfigs(
    existingConfig,
    createSetupConfig(options.providerId, options.providerEndpoint, options),
  )

  await writeSetupConfig(setupConfigPath, nextConfig)
  return 0
}

function createSetupConfig(
  providerId: string,
  providerEndpoint: string,
  options: SetupCommandOptions,
): SetupConfig {
  const models = toArray(options.providerModel).map(model => ({
    id: model,
    name: model,
  }))

  return {
    providers: [
      {
        endpoint: providerEndpoint,
        headers: parseHeaderList(toArray(options.providerHeader)),
        id: providerId,
        models,
        type: 'openai-compatible',
      },
    ],
    version: 1,
  }
}

function toArray(value: string | string[] | undefined): string[] {
  if (value === undefined) {
    return []
  }

  return (Array.isArray(value) ? value : [value]).filter(
    (item): item is string => typeof item === 'string',
  )
}
