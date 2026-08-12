import type { GenAiCallOptions } from '@alint-js/tracing'

import type { ResolvedModel } from './types'

export function modelTraceOptions(
  model: ResolvedModel,
  operationName: string,
): Pick<GenAiCallOptions, 'model' | 'operationName' | 'providerName' | 'serverAddress'> {
  return {
    model: model.id,
    operationName,
    providerName: model.provider.id,
    serverAddress: serverAddressFrom(model.provider.endpoint),
  }
}

function serverAddressFrom(endpoint: string): string | undefined {
  try {
    return new URL(endpoint).hostname
  }
  catch {
    return undefined
  }
}
