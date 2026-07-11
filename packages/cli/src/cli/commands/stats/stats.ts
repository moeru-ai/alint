import type { RunnerConfig } from '@alint-js/config'

import type { StatsDimension } from '../../stats'
import type { CliIo } from '../../types'
import type { StatsCommandOptions } from './options'

import { createLockedPluginResolver, getStatsDir, loadAlintConfig } from '@alint-js/config'
import { errorMessageFrom } from '@moeru/std'

import { createJsonlStatsStore } from '../../stats'
import { loadMergedSetupConfig } from '../config/setup-config'
import { resolveConfigRunner } from '../lint/runner'
import { formatStatsAggregate } from './format'

const DIMENSIONS = new Set<StatsDimension>(['dir', 'model', 'operation', 'rule'])

export async function runStatsCommand(options: StatsCommandOptions, io: CliIo): Promise<number> {
  try {
    const dimension = parseDimension(options.by)
    const pluginResolver = await createLockedPluginResolver(io.cwd)
    const [setupConfig, config] = await Promise.all([
      loadMergedSetupConfig(io),
      loadAlintConfig(io.cwd, undefined, { pluginResolver }),
    ])
    // Note(Makito): No location override via CLI options for now.
    const dir = statsLocation(resolveConfigRunner(config)?.stats)
      ?? statsLocation(setupConfig.runner?.stats)
      ?? getStatsDir(io.env)
    const store = createJsonlStatsStore({ dir })
    const aggregate = await store.query({
      by: dimension,
      cwd: options.here === true ? io.cwd : options.cwd,
      since: options.since,
    })

    io.stdout.write(options.json === true
      ? `${JSON.stringify(aggregate, null, 2)}\n`
      : formatStatsAggregate(aggregate, { color: io.stdout.isTTY === true }))

    return 0
  }
  catch (error) {
    io.stderr.write(`${errorMessageFrom(error) ?? 'Failed to read stats.'}\n`)

    return 2
  }
}

function parseDimension(value: string | undefined): StatsDimension {
  if (value === undefined) {
    return 'model'
  }

  if (DIMENSIONS.has(value as StatsDimension)) {
    return value as StatsDimension
  }

  throw new Error(`Invalid --by "${value}": use rule, operation, model, or dir.`)
}

function statsLocation(stats: RunnerConfig['stats']): string | undefined {
  return typeof stats === 'object' ? stats.location : undefined
}
