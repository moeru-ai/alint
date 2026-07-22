import type { ProviderDefinition, SetupConfig, SetupModelDefinition } from '@alint-js/config'

import type { CommandContext } from '../../command'

import { pruneProviderModels, writeSetupConfig } from '@alint-js/config'

import { escapeLineValue } from '../../../output'
import { probeModels } from '../../../provider-registry'
import { defineCommand } from '../../command'
import { formatUnknownProvider, loadScopedSetupConfig } from '../setup-config'

export type PruneConfirmation = () => Promise<'cancelled' | 'confirmed' | 'declined'>

export interface PruneOptions {
  local?: boolean
  provider?: string | string[]
  yes?: boolean
}

interface ProviderPrunePlan {
  provider: ProviderDefinition
  remoteModelIds: Set<string>
  removedModels: SetupModelDefinition[]
}

export const prune = defineCommand({
  action: runPruneModelsCommand,
  description: 'Remove models unavailable from providers',
  name: 'prune',
  options: [
    { description: 'Provider id', flags: '--provider <id>' },
    { description: 'Read and write project-local config', flags: '--local' },
    { description: 'Disable interactive confirmation', flags: '-N, --no-interactive' },
    { description: 'Confirm model deletion', flags: '--yes' },
  ],
})

/**
 * Removes configured models absent from their providers' model registries.
 *
 * Triggering workflow:
 *
 * {@link registerCommandTree}
 *   -> `config models prune`
 *     -> {@link runPruneModelsCommand}
 *
 * Upstream:
 * - {@link dispatchCommand}
 *
 * Downstream:
 * - {@link confirmPruneModels}
 * - {@link probeModels}
 * - {@link pruneProviderModels}
 * - {@link writeSetupConfig}
 */
export async function runPruneModelsCommand(
  context: CommandContext,
  options: PruneOptions,
  confirm: PruneConfirmation = confirmPruneModels,
): Promise<number> {
  if (Array.isArray(options.provider)) {
    context.io.stderr.write('config models prune accepts --provider only once.\n')
    return 2
  }

  const { config, path, scope } = await loadScopedSetupConfig(context.io, options.local)
  const providers = options.provider === undefined
    ? config.providers
    : config.providers.filter(provider => provider.id === options.provider)

  if (options.provider !== undefined && providers.length === 0) {
    context.io.stderr.write(formatUnknownProvider(options.provider, scope))
    return 2
  }

  const duplicateProviderId = providers.find((provider, providerIndex) =>
    providers.findIndex(candidate => candidate.id === provider.id) !== providerIndex,
  )?.id

  if (duplicateProviderId !== undefined) {
    context.io.stderr.write([
      `provider "${escapeLineValue(duplicateProviderId)}" is configured more than once.`,
      'remove duplicate provider definitions from the setup configuration.',
      '',
    ].join('\n'))
    return 2
  }

  const plans: ProviderPrunePlan[] = []
  let hadFailure = false

  for (const provider of providers) {
    let remoteModelIds: Set<string>

    try {
      remoteModelIds = new Set(await probeModels(provider.endpoint, provider.headers))
    }
    catch {
      hadFailure = true
      context.io.stderr.write(
        `failed to probe provider "${escapeLineValue(provider.id)}" at "${escapeLineValue(provider.endpoint)}".\n`,
      )
      continue
    }

    const removedModels = provider.models.filter(model => !remoteModelIds.has(model.id))
    const defaultModel = removedModels.find(model => (model.aliases ?? []).includes('default'))

    if (defaultModel !== undefined) {
      hadFailure = true
      context.io.stderr.write(
        `cannot prune default model "${escapeLineValue(provider.id)}/${escapeLineValue(defaultModel.id)}". select another default first.\n`,
      )
      continue
    }

    if (removedModels.length > 0) {
      plans.push({ provider, remoteModelIds, removedModels })
    }
  }

  if (plans.length === 0) {
    context.io.stdout.write('no models to prune.\n')
    return hadFailure ? 2 : 0
  }

  context.io.stdout.write([
    'Models to prune:',
    ...plans.flatMap(plan => plan.removedModels.map(model =>
      `  ${escapeLineValue(plan.provider.id)}/${escapeLineValue(model.id)}`,
    )),
    '',
  ].join('\n'))

  if (context.setupNoInteractive && options.yes !== true) {
    context.io.stderr.write('config models prune requires --yes in --no-interactive mode.\n')
    return 2
  }

  if (!context.setupNoInteractive && options.yes !== true) {
    if (context.io.stdin?.isTTY !== true || context.io.stdout.isTTY !== true) {
      context.io.stderr.write('config models prune requires a TTY or -N --yes.\n')
      return 2
    }

    if (await confirm() !== 'confirmed') {
      return 1
    }
  }

  const nextConfig = applyPlans(config, plans)
  await writeSetupConfig(path, nextConfig)
  return hadFailure ? 2 : 0
}

function applyPlans(config: SetupConfig, plans: readonly ProviderPrunePlan[]): SetupConfig {
  return plans.reduce(
    (nextConfig, plan) => pruneProviderModels(nextConfig, plan.provider.id, plan.remoteModelIds),
    config,
  )
}

async function confirmPruneModels(): Promise<'cancelled' | 'confirmed' | 'declined'> {
  const prompts = await import('@clack/prompts')
  const confirmed = await prompts.confirm({ message: 'Remove these configured models?' })

  if (prompts.isCancel(confirmed)) {
    return 'cancelled'
  }

  return confirmed ? 'confirmed' : 'declined'
}
