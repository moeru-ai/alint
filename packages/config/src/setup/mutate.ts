import type {
  ProviderDefinition,
  SetupConfig,
  SetupModelDefinition,
} from '@alint-js/core'

export function addProviderModels(
  config: SetupConfig,
  providerId: string,
  modelIds: readonly string[],
): SetupConfig {
  return updateProvider(config, providerId, (provider) => {
    const knownModelIds = new Set(provider.models.map(model => model.id))
    const addedModels: SetupModelDefinition[] = []

    for (const modelId of modelIds) {
      if (knownModelIds.has(modelId)) {
        continue
      }

      knownModelIds.add(modelId)
      addedModels.push({ id: modelId, name: modelId })
    }

    return {
      ...provider,
      models: [...provider.models, ...addedModels],
    }
  })
}

export function pruneProviderModels(
  config: SetupConfig,
  providerId: string,
  remoteModelIds: ReadonlySet<string>,
): SetupConfig {
  return updateProvider(config, providerId, provider => ({
    ...provider,
    models: provider.models.filter(model => remoteModelIds.has(model.id)),
  }))
}

export function removeProviderModels(
  config: SetupConfig,
  providerId: string,
  modelIds: ReadonlySet<string>,
): SetupConfig {
  return updateProvider(config, providerId, provider => ({
    ...provider,
    models: provider.models.filter(model => !modelIds.has(model.id)),
  }))
}

export function replaceSetupProvider(
  config: SetupConfig,
  replacement: ProviderDefinition,
): SetupConfig {
  return updateProvider(config, replacement.id, () => cloneProvider(replacement))
}

export function setProviderEndpoint(
  config: SetupConfig,
  providerId: string,
  endpoint: string,
): SetupConfig {
  return updateProvider(config, providerId, provider => ({
    ...provider,
    endpoint,
  }))
}

export function setProviderHeader(
  config: SetupConfig,
  providerId: string,
  name: string,
  value: string,
): SetupConfig {
  return updateProvider(config, providerId, provider => ({
    ...provider,
    headers: {
      ...provider.headers,
      [name]: value,
    },
  }))
}

export function unsetProviderHeader(
  config: SetupConfig,
  providerId: string,
  name: string,
): SetupConfig {
  return updateProvider(config, providerId, (provider) => {
    if (provider.headers === undefined) {
      return provider
    }

    const headers = Object.fromEntries(
      Object.entries(provider.headers).filter(([headerName]) => headerName !== name),
    )

    return {
      ...provider,
      headers: Object.keys(headers).length === 0 ? undefined : headers,
    }
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

function cloneProvider(provider: ProviderDefinition): ProviderDefinition {
  return {
    ...provider,
    headers: provider.headers === undefined ? undefined : { ...provider.headers },
    models: provider.models.map(cloneModel),
  }
}

function updateProvider(
  config: SetupConfig,
  providerId: string,
  update: (provider: ProviderDefinition) => ProviderDefinition,
): SetupConfig {
  if (!config.providers.some(provider => provider.id === providerId)) {
    throw new Error(`Unknown provider "${providerId}".`)
  }

  return {
    ...config,
    providers: config.providers.map((provider) => {
      const clonedProvider = cloneProvider(provider)
      return provider.id === providerId ? update(clonedProvider) : clonedProvider
    }),
  }
}
