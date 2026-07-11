import type { AlintConfig } from '@alint-js/core'

import { resolve } from 'node:path'

import { loadConfig } from 'c12'
import { createJiti } from 'jiti/static'

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
    // NOTICE: c12's default `jiti` import lazy-loads `../dist/babel.cjs`,
    // which Bun standalone executables do not discover while compiling. The
    // `jiti/static` entrypoint exists for this exact packaging shape and keeps
    // Babel's transform bundle in the static module graph.
    //
    // Source: `https://github.com/unjs/jiti/blob/fd3bb289b75ed207edfb686d671ed50144f7e90f/lib/jiti-static.mjs#L3-L4`
    jiti: createJiti(resolve(cwd, configFile ?? 'alint.config'), {
      interopDefault: true,
      moduleCache: false,
    }),
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
