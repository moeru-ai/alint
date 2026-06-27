import process from 'node:process'

import { homedir } from 'node:os'

import { join } from 'pathe'
import { xdgConfig } from 'xdg-basedir'

export interface GlobalSetupConfigPathOptions {
  isMacOS?: boolean
  xdgConfig?: string
}

export function getGlobalSetupConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  options: GlobalSetupConfigPathOptions = {},
): string {
  const configHome = env.XDG_CONFIG_HOME ?? resolveDefaultConfigHome(options)
  return join(configHome, 'alint', 'config.toml')
}

export function getProjectSetupConfigPath(cwd: string): string {
  return join(cwd, '.alint', 'config.toml')
}

function resolveDefaultConfigHome(options: GlobalSetupConfigPathOptions): string {
  if (options.isMacOS ?? process.platform === 'darwin') {
    return join(homedir(), '.config')
  }

  return options.xdgConfig ?? xdgConfig ?? join(homedir(), '.config')
}
