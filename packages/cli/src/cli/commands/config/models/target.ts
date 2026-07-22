import type {
  ProviderDefinition,
  SetupConfig,
  SetupModelDefinition,
} from '@alint-js/core'

export type ExactModelTargetResult
  = | { candidates: Array<{ modelId: string, providerId: string }>, status: 'ambiguous' }
    | { model: SetupModelDefinition, provider: ProviderDefinition, status: 'found' }
    | { modelId: string, provider?: ProviderDefinition, status: 'missing' }
    | { modelId: string, providerId: string, status: 'duplicate' }
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
  const qualifiedProviders = qualifier === undefined
    ? []
    : config.providers.filter(provider => provider.id === qualifier)
  const qualifiedProviderId = qualifiedProviders[0]?.id
  const modelId = qualifiedProviders.length === 0
    ? request
    : request.slice(separatorIndex + 1)

  if (
    qualifiedProviderId !== undefined
    && requestedProviderId !== undefined
    && qualifiedProviderId !== requestedProviderId
  ) {
    return {
      qualifiedProviderId,
      requestedProviderId,
      status: 'conflict',
    }
  }

  const requestedProviders = requestedProviderId === undefined
    ? []
    : config.providers.filter(provider => provider.id === requestedProviderId)

  if (requestedProviderId !== undefined && requestedProviders.length === 0) {
    return { providerId: requestedProviderId, status: 'unknown-provider' }
  }

  const selectedProviders = qualifiedProviders.length > 0 ? qualifiedProviders : requestedProviders
  const searchedProviders = selectedProviders.length > 0 ? selectedProviders : config.providers
  const candidates = searchedProviders.flatMap(provider =>
    provider.models
      .filter(model => model.id === modelId)
      .map(model => ({ model, provider })),
  )

  if (candidates.length === 0) {
    return { modelId, provider: selectedProviders[0], status: 'missing' }
  }

  const candidatesByIdentity = new Map<string, typeof candidates>()
  for (const candidate of candidates) {
    const identity = `${candidate.provider.id}/${candidate.model.id}`
    candidatesByIdentity.set(identity, [...(candidatesByIdentity.get(identity) ?? []), candidate])
  }

  const duplicate = [...candidatesByIdentity.values()].find(matches => matches.length > 1)?.[0]
  if (duplicate !== undefined) {
    return {
      modelId: duplicate.model.id,
      providerId: duplicate.provider.id,
      status: 'duplicate',
    }
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
