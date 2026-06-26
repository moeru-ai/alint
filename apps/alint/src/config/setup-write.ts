import type { SetupConfig } from './types'

import { mkdir, writeFile } from 'node:fs/promises'

import { dirname } from 'pathe'

import { stringifySetupConfigToml } from './setup-toml'

export async function writeSetupConfig(
  filePath: string,
  config: SetupConfig,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, stringifySetupConfigToml(config), 'utf8')
}
