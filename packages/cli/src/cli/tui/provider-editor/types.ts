import type { ProviderDefinition, SetupConfig } from '@alint-js/config'

import type { ProviderSetupSource } from '../../provider-registry'
import type { CliIo } from '../../types'

export interface DefaultAliasTarget {
  modelId: string
  providerId: string
}

export interface ModelOption {
  hint?: string
  label: string
  value: string
}

export interface ProviderEditorInput {
  config: SetupConfig
  existingProvider?: ProviderDefinition
  io: CliIo
  mode: 'create' | 'update'
  source: ProviderSetupSource
}

export interface ProviderEditorPromptPort {
  confirm: (summary: string) => Promise<'back' | 'cancelled' | 'no' | 'yes'>
  defaultAction: (firstModelId: string) => Promise<'back' | 'cancelled' | 'no' | 'selectAnother' | 'yes'>
  defaultModel: (options: ModelOption[]) => Promise<'back' | 'cancelled' | string>
  endpoint: (initialValue: string | undefined) => Promise<'back' | 'cancelled' | string>
  headerInput: () => Promise<'back' | 'cancelled' | string>
  manualModels: () => Promise<'back' | 'cancelled' | string[]>
  models: (options: ModelOption[], initialValues: string[]) => Promise<'back' | 'cancelled' | string[]>
  probe: (endpoint: string, headers: Record<string, string>) => Promise<string[]>
  providerId: (initialValue: string, editable: boolean) => Promise<'back' | 'cancelled' | string>
  retainedHeaders: (headerNames: string[]) => Promise<'back' | 'cancelled' | string[]>
}

export type ProviderEditorResult
  = | { defaultAliasTarget?: DefaultAliasTarget, provider: ProviderDefinition, status: 'confirmed' }
    | { status: 'back' }
    | { status: 'cancelled' }
