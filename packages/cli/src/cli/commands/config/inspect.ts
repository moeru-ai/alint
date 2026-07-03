import type { CliIo } from '../../types'

import { loadAlintConfig } from '@alint-js/config'
import { resolveConfigForFile } from '@alint-js/core'
import { resolve } from 'pathe'

import { defineCommand } from '../command'

export const inspect = defineCommand({
  action: (context, file: string, options: { config?: string }) =>
    runConfigInspectCommand(file, options.config, context.io),
  arguments: '<file>',
  description: 'Inspect resolved config for a file',
  name: 'inspect',
})

async function runConfigInspectCommand(
  file: string,
  configPath: string | undefined,
  io: CliIo,
): Promise<number> {
  const config = await loadAlintConfig(io.cwd, configPath)
  const result = resolveConfigForFile(resolve(io.cwd, file), config, { cwd: io.cwd })

  io.stdout.write(`file: ${file}\n`)
  io.stdout.write(`ignored: ${result.ignored ? 'yes' : 'no'}\n`)
  io.stdout.write('matched:\n')

  for (const item of result.matched) {
    io.stdout.write(`  - ${item.name ?? '<anonymous>'}\n`)
  }

  io.stdout.write(`language: ${result.config.language ?? '<inferred>'}\n`)
  io.stdout.write('rules:\n')

  for (const [id, entry] of Object.entries(result.config.rules)) {
    io.stdout.write(`  ${id}: ${Array.isArray(entry) ? entry[0] : entry}\n`)
  }

  return 0
}
