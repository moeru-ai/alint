import type {
  ProviderDefinition,
  SetupConfig,
  SetupModelDefinition,
} from '@alint-js/core'

export type ExactModelTargetResult
  = | { candidates: Array<{ modelId: string, providerId: string }>, status: 'ambiguous' }
    | { model: SetupModelDefinition, provider: ProviderDefinition, status: 'found' }
    | { modelId: string, provider?: ProviderDefinition, status: 'missing' }
    | { providerId: string, status: 'unknown-provider' }
    | { qualifiedProviderId: string, requestedProviderId: string, status: 'conflict' }

export function resolveExactModelTarget(
  config: SetupConfig,
  request: string,
  requestedProviderId: string | undefined,
): ExactModelTargetResult {
  // A slash starts a provider qualifier only when its prefix names a provider in
  // this scope. Otherwise the complete request remains a valid slash-containing ID.
  const separatorIndex = request.indexOf('/')
  const qualifier = separatorIndex === -1 ? undefined : request.slice(0, separatorIndex)
  const qualifiedProvider = qualifier === undefined
    ? undefined
    : config.providers.find(provider => provider.id === qualifier)
  const modelId = qualifiedProvider === undefined
    ? request
    : request.slice(separatorIndex + 1)

  if (
    qualifiedProvider !== undefined
    && requestedProviderId !== undefined
    && qualifiedProvider.id !== requestedProviderId
  ) {
    return {
      qualifiedProviderId: qualifiedProvider.id,
      requestedProviderId,
      status: 'conflict',
    }
  }

  const requestedProvider = requestedProviderId === undefined
    ? undefined
    : config.providers.find(provider => provider.id === requestedProviderId)

  if (requestedProviderId !== undefined && requestedProvider === undefined) {
    return { providerId: requestedProviderId, status: 'unknown-provider' }
  }

  const selectedProvider = qualifiedProvider ?? requestedProvider

  if (selectedProvider !== undefined) {
    const model = findExactModel(selectedProvider, modelId)

    return model === undefined
      ? { modelId, provider: selectedProvider, status: 'missing' }
      : { model, provider: selectedProvider, status: 'found' }
  }

  const candidates = config.providers.flatMap((provider) => {
    // One provider is one target even if malformed config repeats the same ID;
    // removal filters every matching entry from that provider in one mutation.
    const model = findExactModel(provider, modelId)
    return model === undefined ? [] : [{ model, provider }]
  })

  if (candidates.length === 0) {
    return { modelId, status: 'missing' }
  }

  if (candidates.length > 1) {
    return {
      candidates: candidates.map(candidate => ({
        modelId: candidate.model.id,
        providerId: candidate.provider.id,
      })),
      status: 'ambiguous',
    }
  }

  return { ...candidates[0]!, status: 'found' }
}

function findExactModel(provider: ProviderDefinition, modelId: string): SetupModelDefinition | undefined {
  const matches = provider.models.filter(model => model.id === modelId)

  // Prefer the protected duplicate so callers cannot remove a default-aliased
  // entry merely because malformed configuration placed another copy first.
  return matches.find(model => model.aliases?.includes('default')) ?? matches[0]
}
