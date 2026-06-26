import type { AlintConfig } from '../dsl/types'

import { loadConfig } from 'c12'

export async function loadAlintConfig(
  cwd: string,
  configFile?: string,
): Promise<AlintConfig> {
  const result = await loadConfig<AlintConfig>({
    configFile,
    cwd,
    defaults: {
      plugins: [],
      rules: {},
    },
    dotenv: true,
    name: 'alint',
  })

  return result.config
}
