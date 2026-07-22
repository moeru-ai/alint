import type { CommandContext } from '../../command'

import { removeProviderModels, writeSetupConfig } from '@alint-js/config'

import { escapeLineValue, formatDuplicateModelIdentity } from '../../../provider-registry'
import { defineCommand } from '../../command'
import { formatUnknownProvider, loadScopedSetupConfig } from '../setup-config'
import { resolveExactModelTarget } from './target'

export interface RemoveModelOptions {
  local?: boolean
  provider?: string | string[]
}

export const rm = defineCommand({
  action: runRemoveModelCommand,
  arguments: '<model-id>',
  description: 'Remove a configured model',
  exactArguments: true,
  name: 'rm',
  options: [
    { description: 'Provider id', flags: '--provider <id>' },
    { description: 'Read and write project-local config', flags: '--local' },
  ],
})

/**
 * Removes an exact model ID from the explicitly selected setup-config scope.
 *
 * Triggering workflow:
 *
 * {@link registerCommandTree}
 *   -> `config models rm`
 *     -> {@link runRemoveModelCommand}
 *
 * Upstream:
 * - {@link dispatchCommand}
 *
 * Downstream:
 * - {@link resolveExactModelTarget}
 * - {@link removeProviderModels}
 * - {@link writeSetupConfig}
 */
async function runRemoveModelCommand(
  context: CommandContext,
  request: string,
  options: RemoveModelOptions,
): Promise<number> {
  if (Array.isArray(options.provider)) {
    context.io.stderr.write('config models rm accepts --provider only once.\n')
    return 2
  }

  const { config, path, scope } = await loadScopedSetupConfig(context.io, options.local)
  const target = resolveExactModelTarget(config, request, options.provider)

  if (target.status === 'conflict') {
    context.io.stderr.write(
      `model provider ${JSON.stringify(target.qualifiedProviderId)} conflicts with --provider ${JSON.stringify(target.requestedProviderId)}.\n`,
    )
    return 2
  }

  if (target.status === 'unknown-provider') {
    context.io.stderr.write(formatUnknownProvider(target.providerId, scope))
    return 2
  }

  if (target.status === 'ambiguous') {
    context.io.stderr.write([
      `ambiguous model id ${JSON.stringify(request)}.`,
      'specify <provider>/<model-id> or pass --provider <provider-id>:',
      ...target.candidates.map(candidate =>
        `  ${escapeLineValue(candidate.providerId)}/${escapeLineValue(candidate.modelId)}`,
      ),
      '',
    ].join('\n'))
    return 2
  }

  if (target.status === 'duplicate') {
    context.io.stderr.write(
      formatDuplicateModelIdentity(`${target.providerId}/${target.modelId}`),
    )
    return 2
  }

  if (target.status === 'missing') {
    return 0
  }

  if ((target.model.aliases ?? []).includes('default')) {
    context.io.stderr.write(
      `cannot remove default model ${JSON.stringify(`${target.provider.id}/${target.model.id}`)}. select another default first.\n`,
    )
    return 2
  }

  const nextConfig = removeProviderModels(config, target.provider.id, new Set([target.model.id]))
  await writeSetupConfig(path, nextConfig)
  context.io.stdout.write(
    `removed model: ${escapeLineValue(target.provider.id)}/${escapeLineValue(target.model.id)}\nscope: ${scope}\n`,
  )
  return 0
}
