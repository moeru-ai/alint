import type { ProviderSetupSource } from '../../provider-registry'
import type { CliIo } from '../../types'

import process from 'node:process'

import { getGlobalSetupConfigPath, getProjectSetupConfigPath, loadSetupConfig, mergeSetupConfigs, writeSetupConfig } from '@alint-js/config'

import { findProviderSetupSource, providerSetupSources } from '../../provider-registry'
import { runProviderEditor } from '../../tui/provider-editor'
import { applyDefaultAlias } from '../../tui/provider-editor/model-selection'
import { withBackOption } from '../../tui/provider-editor/prompts'

export interface InteractiveSetupIo extends CliIo {}

type SetupScope = 'global' | 'local'
type SetupStep = 'scope' | 'source'

const nonTtyMessage = 'interactive setup requires a TTY. Use -N/--no-interactive with --provider-id and --provider-endpoint.\n'
const backValue = '__alint_back__'

/**
 * Handles setup-only scope/source navigation and persists a confirmed provider.
 *
 * Triggering workflow:
 *
 * {@link setup}
 *   -> {@link runInteractiveSetup}
 *     -> `provider-editor.confirmed`
 *       -> {@link writeSetupConfig}
 *
 * Upstream:
 * - setup command action
 *
 * Downstream:
 * - {@link runProviderEditor} and {@link writeSetupConfig}
 *
 * The handler loads one selected scope once. Back returns to navigation,
 * cancellation writes nothing, and only a confirmed editor result is persisted.
 */
export async function runInteractiveSetup(io: InteractiveSetupIo): Promise<number> {
  if (io.stdin?.isTTY !== true || io.stdout.isTTY !== true) {
    io.stderr.write(nonTtyMessage)
    return 2
  }

  const prompts = await import('@clack/prompts')
  const cancelPrompt = () => {
    prompts.cancel('Setup cancelled.')
    return 1
  }

  prompts.intro('alint setup')

  let scope: SetupScope = 'global'
  let step: SetupStep = 'scope'

  while (true) {
    if (step === 'scope') {
      const selectedScope = await prompts.select<SetupScope>({
        message: 'Where should alint write setup config?',
        options: [
          { label: 'Global', value: 'global' },
          { label: 'Local project', value: 'local' },
        ],
      })

      if (prompts.isCancel(selectedScope)) {
        return cancelPrompt()
      }

      scope = selectedScope
      step = 'source'
      continue
    }

    const selectedSource = await prompts.select<ProviderSetupSource['value'] | typeof backValue>({
      message: 'Choose provider setup mode.',
      options: withBackOption(providerSetupSources.map(({ label, value }) => ({ label, value }))),
    })

    if (prompts.isCancel(selectedSource)) {
      return cancelPrompt()
    }

    if (selectedSource === backValue) {
      step = 'scope'
      continue
    }

    const source = findProviderSetupSource(selectedSource)
    if (source === undefined) {
      return cancelPrompt()
    }

    const configPath = getConfigPath(io, scope)
    const existingConfig = await loadSetupConfig(configPath)
    const result = await runProviderEditor({
      config: existingConfig,
      io,
      mode: 'create',
      source,
    })

    if (result.status === 'back') {
      step = 'source'
      continue
    }

    if (result.status === 'cancelled') {
      return cancelPrompt()
    }

    const merged = mergeSetupConfigs(existingConfig, {
      providers: [result.provider],
      version: 1,
    })
    const nextConfig = result.defaultAliasTarget === undefined
      ? merged
      : applyDefaultAlias(merged, result.defaultAliasTarget)

    await writeSetupConfig(configPath, nextConfig)
    prompts.outro(`Wrote ${configPath}`)
    return 0
  }
}

function getConfigPath(io: InteractiveSetupIo, scope: SetupScope): string {
  return scope === 'local'
    ? getProjectSetupConfigPath(io.cwd)
    : getGlobalSetupConfigPath(io.env ?? process.env)
}
