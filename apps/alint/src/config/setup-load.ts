import type {
  ProviderDefinition,
  SetupConfig,
  SetupModelDefinition,
} from './types'

import { readFile } from 'node:fs/promises'

import { parseSetupConfigToml } from './setup-toml'

export const emptySetupConfig: SetupConfig = { providers: [], version: 1 }

export async function loadSetupConfig(filePath: string): Promise<SetupConfig> {
  try {
    return parseSetupConfigToml(await readFile(filePath, 'utf8'))
  }
  catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return createEmptySetupConfig()
    }

    throw error
  }
}

export function mergeSetupConfigs(...configs: SetupConfig[]): SetupConfig {
  let providers: ProviderDefinition[] = []
  let runner: SetupConfig['runner']
  const providersById = new Map<string, ProviderDefinition>()

  for (const config of configs) {
    const configProviders: ProviderDefinition[] = []

    if (config.runner !== undefined) {
      runner = {
        ...(runner ?? {}),
        ...config.runner,
      }
    }

    for (const provider of config.providers) {
      const existingProvider = providersById.get(provider.id)

      if (existingProvider === undefined) {
        const mergedProvider = cloneProvider(provider)
        providers.push(mergedProvider)
        providersById.set(provider.id, mergedProvider)
        configProviders.push(mergedProvider)
        continue
      }

      existingProvider.endpoint = provider.endpoint
      existingProvider.type = provider.type
      configProviders.push(existingProvider)

      if (provider.headers !== undefined) {
        existingProvider.headers = {
          ...existingProvider.headers,
          ...provider.headers,
        }
      }

      const nextModels: SetupModelDefinition[] = []

      for (const incomingModel of provider.models) {
        const existingModelIndex = existingProvider.models.findIndex(model => model.id === incomingModel.id)

        if (existingModelIndex === -1) {
          nextModels.push(cloneModel(incomingModel))
          continue
        }

        const existingModel = existingProvider.models[existingModelIndex]!
        existingProvider.models.splice(existingModelIndex, 1)
        nextModels.push(mergeModel(existingModel, incomingModel))
      }

      existingProvider.models = [
        ...nextModels,
        ...existingProvider.models,
      ]
    }

    providers = prioritizeProviders(providers, configProviders)
  }

  const mergedConfig: SetupConfig = {
    providers,
    version: 1,
  }

  if (runner !== undefined) {
    mergedConfig.runner = runner
  }

  return mergedConfig
}

function cloneModel(model: SetupModelDefinition): SetupModelDefinition {
  const clonedModel: SetupModelDefinition = { ...model }

  if (model.aliases !== undefined) {
    clonedModel.aliases = [...model.aliases]
  }

  if (model.capabilities !== undefined) {
    clonedModel.capabilities = [...model.capabilities]
  }

  if (model.defaultParams !== undefined) {
    clonedModel.defaultParams = { ...model.defaultParams }
  }

  return clonedModel
}

function cloneProvider(provider: ProviderDefinition): ProviderDefinition {
  const clonedProvider: ProviderDefinition = {
    ...provider,
    models: provider.models.map(cloneModel),
  }

  if (provider.headers !== undefined) {
    clonedProvider.headers = { ...provider.headers }
  }

  return clonedProvider
}

function createEmptySetupConfig(): SetupConfig {
  return { providers: [], version: 1 }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function mergeModel(
  existingModel: SetupModelDefinition,
  incomingModel: SetupModelDefinition,
): SetupModelDefinition {
  const existing = cloneModel(existingModel)
  const incoming = cloneModel(incomingModel)

  return {
    ...existing,
    ...incoming,
    aliases: incoming.aliases ?? existing.aliases,
    capabilities: incoming.capabilities ?? existing.capabilities,
    defaultParams: incoming.defaultParams ?? existing.defaultParams,
  }
}

function prioritizeProviders(
  providers: ProviderDefinition[],
  prioritizedProviders: ProviderDefinition[],
): ProviderDefinition[] {
  const prioritizedProviderIds = new Set(prioritizedProviders.map(provider => provider.id))

  return [
    ...prioritizedProviders,
    ...providers.filter(provider => !prioritizedProviderIds.has(provider.id)),
  ]
}
