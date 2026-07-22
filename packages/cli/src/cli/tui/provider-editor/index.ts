import type { ProviderDefinition } from '@alint-js/config'

import type {
  DefaultAliasTarget,
  ProviderEditorInput,
  ProviderEditorPromptPort,
  ProviderEditorResult,
} from './types'

import { mergeSetupConfigs, replaceSetupProvider } from '@alint-js/config'

import { createProviderId, parseHeaderList } from '../../provider-registry'
import {
  applyHeaderSelection,
  createDefaultModelCandidates,
  createModelOptions,
  modelsFromSelection,
} from './model-selection'
import { createProviderEditorPrompts } from './prompts'

interface EditorDraft {
  defaultAliasTarget?: DefaultAliasTarget
  discoveredModels: string[]
  endpoint?: string
  headerReplacements: Record<string, string>
  providerId?: string
  retainedHeaderNames: string[]
  selectedModelIds?: string[]
}

type EditorStep = 'confirm' | 'defaultAction' | 'defaultModel' | 'endpoint' | 'headerInput' | 'models' | 'providerId' | 'retainedHeaders'

/**
 * Runs one provider create/update request as a reversible prompt state machine.
 *
 * Triggering workflow:
 *
 * {@link runInteractiveSetup}
 *   -> {@link runProviderEditor}
 *     -> `provider-editor.prompt-result`
 *       -> {@link ProviderEditorResult}
 *
 * Upstream:
 * - {@link runInteractiveSetup}
 *
 * Downstream:
 * - {@link createProviderEditorPrompts} and the caller-owned setup-config write
 *
 * The editor reads the selected-scope config, changes only its in-memory draft,
 * and returns without persistence on Back, cancellation, or a negative confirmation.
 */
export async function runProviderEditor(
  input: ProviderEditorInput,
  promptPort?: ProviderEditorPromptPort,
): Promise<ProviderEditorResult> {
  const prompts = promptPort ?? createProviderEditorPrompts(await import('@clack/prompts'))
  const existingProvider = input.mode === 'update' ? input.existingProvider : undefined
  const existingHeaders = { ...existingProvider?.headers }
  const draft: EditorDraft = {
    discoveredModels: [],
    endpoint: existingProvider?.endpoint ?? input.source.defaultEndpoint,
    headerReplacements: {},
    providerId: existingProvider?.id,
    retainedHeaderNames: Object.keys(existingHeaders),
  }
  let step: EditorStep = 'endpoint'

  while (true) {
    if (step === 'endpoint') {
      const endpoint = await prompts.endpoint(draft.endpoint)
      if (endpoint === 'cancelled') {
        return { status: 'cancelled' }
      }
      if (endpoint === 'back') {
        return { status: 'back' }
      }

      draft.endpoint = endpoint.trim()
      step = 'providerId'
      continue
    }

    if (step === 'providerId') {
      const initialProviderId = draft.providerId ?? createProviderId(
        draft.endpoint ?? '',
        new Set(input.config.providers.map(provider => provider.id)),
      )
      const providerId = await prompts.providerId(initialProviderId, input.mode === 'create')
      if (providerId === 'cancelled') {
        return { status: 'cancelled' }
      }
      if (providerId === 'back') {
        step = 'endpoint'
        continue
      }

      draft.providerId = providerId.trim()
      step = 'retainedHeaders'
      continue
    }

    if (step === 'retainedHeaders') {
      const retainedHeaders = await prompts.retainedHeaders(Object.keys(existingHeaders))
      if (retainedHeaders === 'cancelled') {
        return { status: 'cancelled' }
      }
      if (retainedHeaders === 'back') {
        step = 'providerId'
        continue
      }

      draft.retainedHeaderNames = retainedHeaders
      step = 'headerInput'
      continue
    }

    if (step === 'headerInput') {
      const headerInput = await prompts.headerInput()
      if (headerInput === 'cancelled') {
        return { status: 'cancelled' }
      }
      if (headerInput === 'back') {
        step = 'retainedHeaders'
        continue
      }

      draft.headerReplacements = parseHeaderList(splitInput(headerInput)) ?? {}
      const headers = applyHeaderSelection(existingHeaders, draft.retainedHeaderNames, draft.headerReplacements) ?? {}
      draft.discoveredModels = input.source.probeModels
        ? await prompts.probe(draft.endpoint ?? '', headers)
        : []
      step = 'models'
      continue
    }

    if (step === 'models') {
      const options = createModelOptions(existingProvider, draft.discoveredModels)
      const selectedModels = options.length === 0
        ? await prompts.manualModels()
        : await prompts.models(options, draft.selectedModelIds ?? options.map(option => option.value))
      if (selectedModels === 'cancelled') {
        return { status: 'cancelled' }
      }
      if (selectedModels === 'back') {
        step = 'headerInput'
        continue
      }

      draft.selectedModelIds = selectedModels
      step = 'defaultAction'
      continue
    }

    if (step === 'defaultAction') {
      const defaultAction = await prompts.defaultAction(draft.selectedModelIds?.[0] ?? '')
      if (defaultAction === 'cancelled') {
        return { status: 'cancelled' }
      }
      if (defaultAction === 'back') {
        step = 'models'
        continue
      }

      draft.defaultAliasTarget = defaultAction === 'yes'
        ? { modelId: draft.selectedModelIds?.[0] ?? '', providerId: draft.providerId ?? '' }
        : undefined

      const removesCurrentDefault = existingProvider?.models.some(model =>
        model.aliases?.includes('default') === true
        && !draft.selectedModelIds?.includes(model.id),
      ) === true
      step = defaultAction === 'selectAnother' || (defaultAction === 'no' && removesCurrentDefault)
        ? 'defaultModel'
        : 'confirm'
      continue
    }

    const provider = createProvider(input, draft, existingHeaders)

    if (step === 'defaultModel') {
      const provisionalConfig = input.mode === 'update'
        ? replaceSetupProvider(input.config, provider)
        : mergeSetupConfigs(input.config, { providers: [provider], version: 1 })
      const existingModelIds = new Set(existingProvider?.models.map(model => model.id) ?? [])
      const addedModelIds = provider.models
        .map(model => model.id)
        .filter(modelId => !existingModelIds.has(modelId))
      const candidates = createDefaultModelCandidates(provisionalConfig, provider.id, addedModelIds)
      const selectedDefault = await prompts.defaultModel(candidates.map(candidate => ({
        hint: candidate.isCurrentDefault ? 'current default' : candidate.isNew ? 'new' : undefined,
        label: candidate.label,
        value: candidate.value,
      })))
      if (selectedDefault === 'cancelled') {
        return { status: 'cancelled' }
      }
      if (selectedDefault === 'back') {
        step = 'defaultAction'
        continue
      }

      const candidate = candidates.find(item => item.value === selectedDefault)
      if (candidate === undefined) {
        return { status: 'cancelled' }
      }

      draft.defaultAliasTarget = { modelId: candidate.modelId, providerId: candidate.providerId }
      step = 'confirm'
      continue
    }

    const confirmed = await prompts.confirm(createSummary(input, provider, draft.defaultAliasTarget))
    if (confirmed === 'cancelled' || confirmed === 'no') {
      return { status: 'cancelled' }
    }
    if (confirmed === 'back') {
      step = 'defaultAction'
      continue
    }

    return {
      defaultAliasTarget: draft.defaultAliasTarget,
      provider,
      status: 'confirmed',
    }
  }
}

function createProvider(
  input: ProviderEditorInput,
  draft: EditorDraft,
  existingHeaders: Record<string, string>,
): ProviderDefinition {
  return {
    ...input.existingProvider,
    endpoint: draft.endpoint ?? '',
    headers: applyHeaderSelection(existingHeaders, draft.retainedHeaderNames, draft.headerReplacements),
    id: draft.providerId ?? '',
    models: modelsFromSelection(input.existingProvider, draft.selectedModelIds ?? []),
    type: 'openai-compatible',
  }
}

function createSummary(
  input: ProviderEditorInput,
  provider: ProviderDefinition,
  defaultAliasTarget: DefaultAliasTarget | undefined,
): string {
  const existingModelIds = new Set(input.existingProvider?.models.map(model => model.id) ?? [])
  const nextModelIds = new Set(provider.models.map(model => model.id))
  const additions = [...nextModelIds].filter(modelId => !existingModelIds.has(modelId))
  const removals = [...existingModelIds].filter(modelId => !nextModelIds.has(modelId))
  const defaultChange = defaultAliasTarget === undefined
    ? 'unchanged'
    : `${defaultAliasTarget.providerId}/${defaultAliasTarget.modelId}`

  return [
    `${input.mode === 'create' ? 'Create' : 'Update'} provider?`,
    `Provider: ${provider.id}`,
    `Endpoint: ${provider.endpoint}`,
    `Headers: ${Object.keys(provider.headers ?? {}).join(', ') || '(none)'}`,
    `Added models: ${additions.join(', ') || '(none)'}`,
    `Removed models: ${removals.join(', ') || '(none)'}`,
    `Default: ${defaultChange}`,
  ].join('\n')
}

function splitInput(value: string): string[] {
  return value.split(',').map(item => item.trim()).filter(Boolean)
}
