import type { ModelSize } from '../config/types'

export interface ModelRequirement {
  capabilities?: string[]
  minContextWindow?: number
  params?: Record<string, unknown>
  size?: ModelSize
}

export interface ResolvedModel {
  aliases: string[]
  capabilities: string[]
  contextWindow?: number
  id: string
  name: string
  params: Record<string, unknown>
  provider: ResolvedProvider
  size?: ModelSize
}

export interface ResolvedProvider {
  endpoint: string
  headers: Record<string, string>
  id: string
  type: 'openai-compatible'
}

export interface ResolveModelOptions {
  request?: string
  requirement?: ModelRequirement
  ruleId?: string
}
