import type { RunnerConfig } from '@alint-js/config'

import type { StatsAggregate, StatsDimension } from '../../stats'
import type { CliIo } from '../../types'
import type { StatsCommandOptions, StatsMetric } from './options'

import { getStatsDir, loadAlintConfig } from '@alint-js/config'
import { errorMessageFrom } from '@moeru/std'

import { createJsonlStatsStore } from '../../stats'
import { loadMergedSetupConfig } from '../config/setup-config'
import { resolveConfigRunner } from '../lint/runner'
import { formatStatsChart } from './chart'
import { formatStatsAggregate } from './format'

const DIMENSIONS = new Set<StatsDimension>(['dir', 'model', 'operation', 'rule'])
const METRICS = new Set<StatsMetric>(['duration', 'runs', 'tokens'])

export async function runStatsCommand(options: StatsCommandOptions, io: CliIo): Promise<number> {
  try {
    const dimension = parseDimension(options.by)
    const metric = parseMetric(options.metric)

    // Duration is only recorded per rule, so it cannot be ranked by any other grouping.
    if (metric === 'duration' && dimension !== 'rule') {
      throw new Error('The duration metric is only available with --by rule.')
    }

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

    io.stdout.write(render(aggregate, options, metric, /* color */ io.stdout.isTTY === true))

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

function parseMetric(value: string | undefined): StatsMetric {
  if (value === undefined) {
    return 'tokens'
  }

  if (METRICS.has(value as StatsMetric)) {
    return value as StatsMetric
  }

  throw new Error(`Invalid --metric "${value}": use tokens, runs, or duration.`)
}

function render(aggregate: StatsAggregate, options: StatsCommandOptions, metric: StatsMetric, color: boolean): string {
  // When `--json` and `--chart` both exist, `--json` wins.
  if (options.json === true) {
    return `${JSON.stringify(aggregate, null, 2)}\n`
  }

  if (options.chart === true) {
    return formatStatsChart(aggregate, { color, metric })
  }

  return formatStatsAggregate(aggregate, { color, metric })
}

function statsLocation(stats: RunnerConfig['stats']): string | undefined {
  return typeof stats === 'object' ? stats.location : undefined
}
