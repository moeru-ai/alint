import type { ProviderDefinition, SetupConfig, SetupModelDefinition } from '@alint-js/config'

import type { DefaultAliasTarget, ModelOption } from './types'

interface DefaultModelCandidate extends DefaultAliasTarget {
  isCurrentDefault: boolean
  isNew: boolean
  label: string
  value: string
}

export function applyDefaultAlias(config: SetupConfig, target: DefaultAliasTarget): SetupConfig {
  return {
    ...config,
    providers: config.providers.map(provider => ({
      ...provider,
      headers: provider.headers === undefined ? undefined : { ...provider.headers },
      models: provider.models.map((model) => {
        const aliasesWithoutDefault = (model.aliases ?? []).filter(alias => alias !== 'default')
        const aliases = provider.id === target.providerId && model.id === target.modelId
          ? [...aliasesWithoutDefault, 'default']
          : aliasesWithoutDefault

        return {
          ...cloneModel(model),
          aliases: aliases.length > 0 ? aliases : undefined,
        }
      }),
    })),
  }
}

export function applyHeaderSelection(
  existingHeaders: Record<string, string>,
  retainedNames: readonly string[],
  replacements: Record<string, string>,
): Record<string, string> | undefined {
  const retained = Object.fromEntries(
    retainedNames
      .filter(name => existingHeaders[name] !== undefined)
      .map(name => [name, existingHeaders[name]!]),
  )
  const headers = { ...retained, ...replacements }

  return Object.keys(headers).length > 0 ? headers : undefined
}

export function createDefaultModelCandidates(
  config: SetupConfig,
  newProviderId: string,
  newModelIds: string[],
): DefaultModelCandidate[] {
  const candidates: DefaultModelCandidate[] = []
  const seen = new Set<string>()
  const newModelIdSet = new Set(newModelIds)
  const allModels = config.providers.flatMap(provider =>
    provider.models.map(model => ({
      isCurrentDefault: (model.aliases ?? []).includes('default'),
      isNew: provider.id === newProviderId && newModelIdSet.has(model.id),
      model,
      provider,
      value: createDefaultModelCandidateValue(provider.id, model.id),
    })),
  )

  const addCandidate = (candidate: typeof allModels[number] | undefined): void => {
    if (candidate === undefined || seen.has(candidate.value)) {
      return
    }

    seen.add(candidate.value)
    candidates.push({
      isCurrentDefault: candidate.isCurrentDefault,
      isNew: candidate.isNew,
      label: `${candidate.provider.id} / ${candidate.model.id}`,
      modelId: candidate.model.id,
      providerId: candidate.provider.id,
      value: candidate.value,
    })
  }

  addCandidate(allModels.find(candidate => candidate.isCurrentDefault))

  for (const modelId of newModelIds) {
    addCandidate(allModels.find(candidate =>
      candidate.provider.id === newProviderId && candidate.model.id === modelId,
    ))
  }

  for (const candidate of allModels) {
    addCandidate(candidate)
  }

  return candidates
}

export function createModelOptions(
  provider: ProviderDefinition | undefined,
  discoveredIds: readonly string[],
): ModelOption[] {
  const discovered = new Set(discoveredIds)
  const existingIds = new Set(provider?.models.map(model => model.id) ?? [])

  return [
    ...(provider?.models ?? []).map(model => ({
      hint: discovered.has(model.id) ? undefined : 'not reported by provider',
      label: model.id,
      value: model.id,
    })),
    ...discoveredIds
      .filter(modelId => !existingIds.has(modelId))
      .map(modelId => ({ hint: 'new', label: modelId, value: modelId })),
  ]
}

export function modelsFromSelection(
  provider: ProviderDefinition | undefined,
  selectedIds: readonly string[],
): SetupModelDefinition[] {
  const existing = new Map(provider?.models.map(model => [model.id, model]) ?? [])

  return selectedIds.map((modelId) => {
    const model = existing.get(modelId)
    return model === undefined ? { id: modelId, name: modelId } : cloneModel(model)
  })
}

function cloneModel(model: SetupModelDefinition): SetupModelDefinition {
  return {
    ...model,
    aliases: model.aliases === undefined ? undefined : [...model.aliases],
    capabilities: model.capabilities === undefined ? undefined : [...model.capabilities],
    defaultParams: model.defaultParams === undefined ? undefined : { ...model.defaultParams },
  }
}

function createDefaultModelCandidateValue(providerId: string, modelId: string): string {
  return `${providerId}\u0000${modelId}`
}
