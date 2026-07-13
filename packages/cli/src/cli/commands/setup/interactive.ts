import type { ProviderDefinition, SetupModelDefinition } from '@alint-js/config'
import type * as ClackPrompts from '@clack/prompts'

import type { ProviderSetupSource } from '../../provider-registry'

import process from 'node:process'

import { getGlobalSetupConfigPath, getProjectSetupConfigPath, loadSetupConfig, mergeSetupConfigs, writeSetupConfig } from '@alint-js/config'
import { errorMessageFrom } from '@moeru/std/error'

import { createProviderId, findProviderSetupSource, parseHeaderList, probeModels, providerSetupSources } from '../../provider-registry'

export interface InteractiveSetupIo {
  cwd: string
  env?: NodeJS.ProcessEnv
  stderr: { isTTY?: boolean, write: (chunk: string) => unknown }
  stdin?: { isTTY?: boolean }
  stdout: { isTTY?: boolean, write: (chunk: string) => unknown }
}

interface SelectOption<T extends string> {
  label: string
  value: T
}

interface SetupDraft {
  addDefaultAlias?: boolean
  discoveredModels?: string[]
  endpoint?: string
  headerInput?: string
  headers?: Record<string, string>
  providerId?: string
  scope?: SetupScope
  selectedModels?: string[]
  source?: ProviderSetupSource['value']
}

type SetupScope = 'global' | 'local'
type SetupStep = 'confirm' | 'defaultAlias' | 'endpoint' | 'headers' | 'models' | 'providerId' | 'scope' | 'source'

const nonTtyMessage = 'interactive setup requires a TTY. Use -N/--no-interactive with --provider-id and --provider-endpoint.\n'
const backValue = '__alint_back__'

export function formatProbeModelsFailure(endpoint: string, error: unknown): string {
  const hint = endpoint.startsWith('https://localhost:11434')
    ? ' Ollama usually uses http://localhost:11434/v1.'
    : ''

  return `Could not probe models: ${errorMessageFrom(error)}.${hint}`
}

export function isBackInput(value: string): boolean {
  return value.trim() === '..'
}

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

  const draft: SetupDraft = {}
  let step: SetupStep = 'scope'

  while (true) {
    if (step === 'scope') {
      const scope = await prompts.select<SetupScope>({
        message: 'Where should alint write setup config?',
        options: [
          { label: 'Global', value: 'global' },
          { label: 'Local project', value: 'local' },
        ],
      })

      if (prompts.isCancel(scope)) {
        return cancelPrompt()
      }

      draft.scope = scope
      step = 'source'
      continue
    }

    if (step === 'source') {
      const source = await prompts.select<ProviderSetupSource['value'] | typeof backValue>({
        message: 'Choose provider setup mode.',
        options: withBackOption(providerSetupSources.map(({ label, value }) => ({ label, value }))),
      })

      if (prompts.isCancel(source)) {
        return cancelPrompt()
      }

      if (source === backValue) {
        step = 'scope'
        continue
      }

      draft.source = source
      step = 'endpoint'
      continue
    }

    if (step === 'endpoint') {
      const setupSource = findProviderSetupSource(draft.source ?? 'custom')

      if (setupSource === undefined) {
        return cancelPrompt()
      }

      const endpoint = await promptEndpoint(prompts, setupSource)

      if (prompts.isCancel(endpoint)) {
        return cancelPrompt()
      }

      if (typeof endpoint !== 'string') {
        return cancelPrompt()
      }

      if (isBackInput(endpoint)) {
        step = 'source'
        continue
      }

      draft.endpoint = endpoint
      step = 'providerId'
      continue
    }

    if (step === 'providerId') {
      const configPath = getConfigPath(io, draft.scope ?? 'global')
      const existingConfig = await loadSetupConfig(configPath)
      const providerId = await prompts.text({
        defaultValue: draft.providerId ?? createProviderId(draft.endpoint ?? '', new Set(existingConfig.providers.map(provider => provider.id))),
        message: 'Provider id',
        placeholder: 'Type .. to go back',
        validate: value => isBackInput(value ?? '') || (value ?? '').trim().length > 0 ? undefined : 'Provider id is required.',
      })

      if (prompts.isCancel(providerId)) {
        return cancelPrompt()
      }

      if (typeof providerId !== 'string') {
        return cancelPrompt()
      }

      if (isBackInput(providerId)) {
        step = 'endpoint'
        continue
      }

      draft.providerId = providerId
      step = 'headers'
      continue
    }

    if (step === 'headers') {
      const headerInput = await prompts.text({
        defaultValue: draft.headerInput ?? '',
        message: 'Headers',
        placeholder: 'Authorization=Bearer token, X-Test=true; type .. to go back',
        validate: (value) => {
          if (isBackInput(value ?? '')) {
            return undefined
          }

          try {
            parseHeaderList(splitHeaderInput(value ?? ''))
            return undefined
          }
          catch {
            return 'Headers must be comma-separated Key=Value entries.'
          }
        },
      })

      if (prompts.isCancel(headerInput)) {
        return cancelPrompt()
      }

      if (typeof headerInput !== 'string') {
        return cancelPrompt()
      }

      if (isBackInput(headerInput)) {
        step = 'providerId'
        continue
      }

      draft.headerInput = headerInput
      draft.headers = parseHeaderList(splitHeaderInput(headerInput))
      draft.discoveredModels = findProviderSetupSource(draft.source ?? 'custom')?.probeModels === false
        ? []
        : await probeModelsWithSpinner(prompts, draft.endpoint ?? '', draft.headers)
      step = 'models'
      continue
    }

    if (step === 'models') {
      const selectedModels = await promptModels(prompts, draft.discoveredModels ?? [])

      if (prompts.isCancel(selectedModels)) {
        return cancelPrompt()
      }

      if (selectedModels === backValue) {
        step = 'headers'
        continue
      }

      if (!Array.isArray(selectedModels)) {
        return cancelPrompt()
      }

      draft.selectedModels = selectedModels
      step = 'defaultAlias'
      continue
    }

    if (step === 'defaultAlias') {
      const addDefaultAlias = await prompts.select<'no' | 'yes' | typeof backValue>({
        message: `Add alias "default" to ${draft.selectedModels?.[0]}?`,
        options: withBackOption([
          { label: 'Yes', value: 'yes' },
          { label: 'No', value: 'no' },
        ]),
      })

      if (prompts.isCancel(addDefaultAlias)) {
        return cancelPrompt()
      }

      if (addDefaultAlias === backValue) {
        step = 'models'
        continue
      }

      draft.addDefaultAlias = addDefaultAlias === 'yes'
      step = 'confirm'
      continue
    }

    const nextProvider = createProviderConfig(
      (draft.providerId ?? '').trim(),
      (draft.endpoint ?? '').trim(),
      draft.headers,
      draft.selectedModels ?? [],
      draft.addDefaultAlias ?? true,
    )
    const confirmed = await prompts.select<'no' | 'yes' | typeof backValue>({
      message: [
        `Write ${draft.scope} setup config?`,
        `Provider: ${nextProvider.id}`,
        `Endpoint: ${nextProvider.endpoint}`,
        `Models: ${(draft.selectedModels ?? []).join(', ')}`,
      ].join('\n'),
      options: withBackOption([
        { label: 'Yes', value: 'yes' },
        { label: 'No', value: 'no' },
      ]),
    })

    if (prompts.isCancel(confirmed)) {
      return cancelPrompt()
    }

    if (confirmed === backValue) {
      step = 'defaultAlias'
      continue
    }

    if (confirmed === 'no') {
      return cancelPrompt()
    }

    const configPath = getConfigPath(io, draft.scope ?? 'global')
    const existingConfig = await loadSetupConfig(configPath)
    const nextConfig = mergeSetupConfigs(existingConfig, {
      providers: [nextProvider],
      version: 1,
    })

    await writeSetupConfig(configPath, nextConfig)
    prompts.outro(`Wrote ${configPath}`)
    return 0
  }
}

export function withBackOption<T extends string>(options: SelectOption<T>[]): Array<SelectOption<T | typeof backValue>> {
  return [...options, { label: 'Back', value: backValue }]
}

function createProviderConfig(
  providerId: string,
  endpoint: string,
  headers: Record<string, string> | undefined,
  modelIds: string[],
  addDefaultAlias: boolean,
): ProviderDefinition {
  return {
    endpoint,
    headers,
    id: providerId,
    models: modelIds.map((modelId, index): SetupModelDefinition => ({
      aliases: index === 0 && addDefaultAlias ? ['default'] : undefined,
      id: modelId,
      name: modelId,
    })),
    type: 'openai-compatible',
  }
}

function getConfigPath(io: InteractiveSetupIo, scope: SetupScope): string {
  return scope === 'local'
    ? getProjectSetupConfigPath(io.cwd)
    : getGlobalSetupConfigPath(io.env ?? process.env)
}

async function probeModelsWithSpinner(
  prompts: typeof ClackPrompts,
  endpoint: string,
  headers: Record<string, string> | undefined,
): Promise<string[]> {
  const spinner = prompts.spinner()

  spinner.start('Probing models')

  try {
    const models = await probeModels(endpoint, headers ?? {})
    spinner.stop(models.length > 0 ? `Found ${models.length} models` : 'No models discovered')
    return models
  }
  catch (error) {
    spinner.stop(formatProbeModelsFailure(endpoint, error))
    return []
  }
}

async function promptEndpoint(
  prompts: typeof ClackPrompts,
  source: ProviderSetupSource,
): Promise<string | symbol> {
  return prompts.text({
    defaultValue: source.defaultEndpoint,
    message: 'Provider endpoint',
    placeholder: `${source.defaultEndpoint ?? 'https://example.test/v1'}; type .. to go back`,
    validate: value => isBackInput(value ?? '') || (value ?? '').trim().length > 0 ? undefined : 'Provider endpoint is required.',
  })
}

async function promptModels(
  prompts: typeof ClackPrompts,
  discoveredModels: string[],
): Promise<string[] | symbol | typeof backValue> {
  if (discoveredModels.length > 0) {
    const selectedModels = await prompts.multiselect<string>({
      message: 'Select models',
      options: withBackOption(discoveredModels.map(model => ({ label: model, value: model }))),
      required: true,
    })

    return Array.isArray(selectedModels) && selectedModels.includes(backValue)
      ? backValue
      : selectedModels
  }

  const modelInput = await prompts.text({
    message: 'Models',
    placeholder: 'qwen:8b, qwen:32b; type .. to go back',
    validate: value => isBackInput(value ?? '') || splitModelInput(value ?? '').length > 0 ? undefined : 'At least one model is required.',
  })

  if (prompts.isCancel(modelInput)) {
    return modelInput
  }

  return isBackInput(modelInput) ? backValue : splitModelInput(modelInput)
}

function splitHeaderInput(value: string): string[] {
  return value.split(',').map(item => item.trim()).filter(Boolean)
}

function splitModelInput(value: string): string[] {
  return value.split(',').map(item => item.trim()).filter(Boolean)
}
