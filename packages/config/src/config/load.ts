import type { AlintConfig } from '@alint-js/core'

import { loadConfig } from 'c12'

interface C12LoadConfigResult {
  _configFile?: string
}

export async function loadAlintConfig(
  cwd: string,
  configFile?: string,
): Promise<AlintConfig> {
  const result = await loadConfig<AlintConfig>({
    configFile,
    cwd,
    dotenv: true,
    name: 'alint',
  })

  // NOTICE: c12 returns `{}` for a missing config even without defaults. The
  // resolved config-file marker is the only result field that distinguishes
  // "not found" from an intentionally exported empty object.
  if ((result as C12LoadConfigResult)._configFile === undefined) {
    return []
  }

  return result.config ?? []
}
