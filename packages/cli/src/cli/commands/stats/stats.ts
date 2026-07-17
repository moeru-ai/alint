import type { RunnerConfig } from '@alint-js/config'

import type { StatsAggregate, StatsDimension } from '../../stats'
import type { CliIo } from '../../types'
import type { StatsCommandOptions } from './options'

import { getStatsDir, loadAlintConfig } from '@alint-js/config'
import { errorMessageFrom } from '@moeru/std'

import { createJsonlStatsStore } from '../../stats'
import { loadMergedSetupConfig } from '../config/setup-config'
import { resolveConfigRunner } from '../lint/runner'
import { formatStatsChart } from './chart'
import { formatStatsAggregate } from './format'

const DIMENSIONS = new Set<StatsDimension>(['dir', 'model', 'operation', 'rule'])

export async function runStatsCommand(options: StatsCommandOptions, io: CliIo): Promise<number> {
  try {
    const dimension = parseDimension(options.by)
    const [setupConfig, config] = await Promise.all([
      loadMergedSetupConfig(io),
      loadAlintConfig(io.cwd),
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

    io.stdout.write(render(aggregate, options, /* color */ io.stdout.isTTY === true))

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

function render(aggregate: StatsAggregate, options: StatsCommandOptions, color: boolean): string {
  // When `--json` and `--chart` both exist, `--json` wins.
  if (options.json === true) {
    return `${JSON.stringify(aggregate, null, 2)}\n`
  }

  if (options.chart === true) {
    return formatStatsChart(aggregate, { color })
  }

  return formatStatsAggregate(aggregate, { color })
}

function statsLocation(stats: RunnerConfig['stats']): string | undefined {
  return typeof stats === 'object' ? stats.location : undefined
}
