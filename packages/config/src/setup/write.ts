import type { SetupConfig } from '@alint-js/core'

import { mkdir, writeFile } from 'node:fs/promises'

import { dirname } from 'pathe'

import { stringifySetupConfigToml } from './toml'

export async function writeSetupConfig(
  filePath: string,
  config: SetupConfig,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, stringifySetupConfigToml(config), 'utf8')
}
