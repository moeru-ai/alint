import type { CommandContext } from '../../command'

import { benchmarkModels } from '@alint-js/core'
import { errorMessageFrom } from '@moeru/std/error'

import { formatModelBenchmarkList, formatModelList, resolveProviderBenchmarkConcurrency } from '../../../provider-registry'
import { defineCommand } from '../../command'
import { loadMergedSetupConfig } from '../setup-config'
import { createModelBenchmarkProgressDisplay } from './benchmark-progress'

interface ListModelsOptions {
  withSpeed?: boolean
  withSpeedConcurrency?: string | string[]
}

export const ls = defineCommand({
  action: runListModelsCommand,
  alias: ['ls'],
  description: 'List configured models',
  name: 'list',
  options: [
    { description: 'Benchmark configured models with live requests', flags: '--with-speed' },
    { description: 'Override one provider benchmark concurrency (repeatable)', flags: '--with-speed-concurrency <provider-id=limit>' },
  ],
})

/**
 * Lists configured models and optionally benchmarks each model with live streamed requests.
 *
 * Triggering workflow:
 *
 * {@link defineCommand}
 *   -> `config models list`
 *     -> {@link runListModelsCommand}
 *
 * Upstream:
 * - `config models list` command dispatch
 *
 * Downstream:
 * - {@link loadMergedSetupConfig}
 * - {@link benchmarkModels}
 * - {@link createModelBenchmarkProgressDisplay}
 * - `context.io.stdout.write`
 */
async function runListModelsCommand(
  context: CommandContext,
  options: ListModelsOptions,
): Promise<number> {
  const config = await loadMergedSetupConfig(context.io)
  const concurrencyOverrides = options.withSpeedConcurrency === undefined
    ? []
    : [options.withSpeedConcurrency].flat()

  if (options.withSpeed !== true) {
    if (concurrencyOverrides.length > 0) {
      context.io.stderr.write('--with-speed-concurrency requires --with-speed.\n')
      return 2
    }

    context.io.stdout.write(formatModelList(config))
    return 0
  }

  let providerConcurrency: Record<string, number>

  try {
    providerConcurrency = resolveProviderBenchmarkConcurrency(config, concurrencyOverrides)
  }
  catch (error) {
    context.io.stderr.write(`${errorMessageFrom(error) ?? 'Invalid benchmark concurrency override.'}\n`)
    return 2
  }

  const progress = context.io.stderr.isTTY === true
    ? createModelBenchmarkProgressDisplay({
        color: true,
        config,
        output: context.io.stderr,
      })
    : undefined
  let benchmarks

  try {
    benchmarks = await benchmarkModels(config, {
      onProgress: snapshot => progress?.update(snapshot),
      providerConcurrency,
    })
  }
  finally {
    progress?.finish()
  }

  context.io.stdout.write(formatModelBenchmarkList(config, benchmarks, {
    color: context.io.stdout.isTTY === true,
  }))
  return 0
}
