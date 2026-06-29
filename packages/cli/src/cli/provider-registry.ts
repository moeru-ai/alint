import type { ProviderDefinition, SetupConfig, SetupModelDefinition } from '@alint-js/config'

import { getBorderCharacters, table } from 'table'

export interface FlattenedModel {
  model: SetupModelDefinition
  provider: ProviderDefinition
}

export function buildModelsUrl(endpoint: string): string {
  return new URL('models', endpoint.endsWith('/') ? endpoint : `${endpoint}/`).toString()
}

export function createProviderId(endpoint: string, existingIds: Set<string>): string {
  let base = 'provider'

  try {
    base = new URL(endpoint).hostname.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'provider'
  }
  catch {
    base = 'provider'
  }

  if (!existingIds.has(base)) {
    return base
  }

  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`

    if (!existingIds.has(candidate)) {
      return candidate
    }
  }
}

export function findModel(config: SetupConfig, request: string): FlattenedModel | undefined {
  return flattenModels(config).find(({ model }) =>
    model.id === request || model.name === request || (model.aliases ?? []).includes(request),
  )
}

export function flattenModels(config: SetupConfig): FlattenedModel[] {
  return config.providers.flatMap(provider =>
    provider.models.map(model => ({ model, provider })),
  )
}

export function formatModelList(config: SetupConfig): string {
  const rows = flattenModels(config)

  return formatTable([
    ['id', 'provider', 'name'],
    ...rows.map(({ model, provider }) => [
      model.id,
      provider.id,
      model.name ?? model.id,
    ]),
  ])
}

export function formatModelShow(candidate: FlattenedModel): string {
  const { model, provider } = candidate
  const lines = [
    `id: ${model.id}`,
    `name: ${model.name ?? model.id}`,
    `provider: ${provider.id}`,
    `endpoint: ${provider.endpoint}`,
  ]

  if (model.aliases?.length) {
    lines.push(`aliases: ${model.aliases.join(', ')}`)
  }

  if (model.capabilities?.length) {
    lines.push(`capabilities: ${model.capabilities.join(', ')}`)
  }

  if (model.size !== undefined) {
    lines.push(`size: ${model.size}`)
  }

  if (model.contextWindow !== undefined) {
    lines.push(`contextWindow: ${model.contextWindow}`)
  }

  if (model.defaultParams !== undefined) {
    lines.push(`defaultParams: ${JSON.stringify(model.defaultParams)}`)
  }

  return `${lines.join('\n')}\n`
}

export function formatProviderList(config: SetupConfig): string {
  return formatTable([
    ['id', 'type', 'endpoint', 'models'],
    ...config.providers.map(provider => [
      provider.id,
      provider.type,
      provider.endpoint,
      String(provider.models.length),
    ]),
  ])
}

export function formatProviderShow(provider: ProviderDefinition): string {
  const lines = [
    `id: ${provider.id}`,
    `type: ${provider.type}`,
    `endpoint: ${provider.endpoint}`,
    `models: ${provider.models.map(model => model.id).join(', ')}`,
  ]
  const headerKeys = Object.keys(provider.headers ?? {})

  if (headerKeys.length > 0) {
    lines.push(`headers: ${headerKeys.join(', ')}`)
  }

  return `${lines.join('\n')}\n`
}

export function parseHeaderList(headers: string[]): Record<string, string> | undefined {
  if (headers.length === 0) {
    return undefined
  }

  const parsedHeaders: Record<string, string> = {}

  for (const header of headers) {
    const separatorIndex = header.indexOf('=')

    if (separatorIndex <= 0) {
      throw new Error(`Invalid provider header "${header}". Expected Key=Value.`)
    }

    parsedHeaders[header.slice(0, separatorIndex)] = header.slice(separatorIndex + 1)
  }

  return parsedHeaders
}

export async function probeModels(endpoint: string, headers: Record<string, string> = {}): Promise<string[]> {
  const response = await fetch(buildModelsUrl(endpoint), { headers })

  if (!response.ok) {
    throw new Error(`GET ${buildModelsUrl(endpoint)} returned ${response.status}.`)
  }

  const body = await response.json() as { data?: Array<{ id?: unknown }> }
  if (!Array.isArray(body.data)) {
    throw new TypeError('Expected OpenAI-compatible models response with data array.')
  }

  return body.data
    .map(model => model.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
}

function formatTable(rows: string[][]): string {
  if (rows.length <= 1) {
    return ''
  }

  return table(rows, {
    border: getBorderCharacters('void'),
    columnDefault: {
      paddingLeft: 0,
      paddingRight: 2,
    },
    drawHorizontalLine: () => false,
  })
}
