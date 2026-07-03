import type { SetupConfig } from '@alint-js/config'

import type { CliIo } from '../../types'

import process from 'node:process'

import { getGlobalSetupConfigPath, getProjectSetupConfigPath, loadSetupConfig, mergeSetupConfigs } from '@alint-js/config'

export async function loadMergedSetupConfig(io: CliIo): Promise<SetupConfig> {
  const globalSetupConfigPath = getGlobalSetupConfigPath(io.env ?? process.env)
  const projectSetupConfigPath = getProjectSetupConfigPath(io.cwd)
  const [globalSetupConfig, projectSetupConfig] = await Promise.all([
    loadSetupConfig(globalSetupConfigPath),
    loadSetupConfig(projectSetupConfigPath),
  ])

  return mergeSetupConfigs(globalSetupConfig, projectSetupConfig)
}
