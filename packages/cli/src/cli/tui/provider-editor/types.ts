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
  confirm: (summary: string) => Promise<ProviderEditorPromptResult<'no' | 'yes'>>
  defaultAction: (firstModelId: string) => Promise<ProviderEditorPromptResult<'no' | 'selectAnother' | 'yes'>>
  defaultModel: (options: ModelOption[]) => Promise<ProviderEditorPromptResult<string>>
  endpoint: (initialValue: string | undefined) => Promise<ProviderEditorPromptResult<string>>
  headerInput: () => Promise<ProviderEditorPromptResult<string>>
  manualModels: () => Promise<ProviderEditorPromptResult<string[]>>
  models: (options: ModelOption[], initialValues: string[]) => Promise<ProviderEditorPromptResult<string[]>>
  probe: (endpoint: string, headers: Record<string, string>) => Promise<string[]>
  providerId: (initialValue: string, editable: boolean) => Promise<ProviderEditorPromptResult<string>>
  retainedHeaders: (headerNames: string[], initialValues: string[]) => Promise<ProviderEditorPromptResult<string[]>>
}

export type ProviderEditorPromptResult<T>
  = | { status: 'back' }
    | { status: 'cancelled' }
    | { status: 'submitted', value: T }

export type ProviderEditorResult
  = | { defaultAliasTarget?: DefaultAliasTarget, provider: ProviderDefinition, status: 'confirmed' }
    | { status: 'back' }
    | { status: 'cancelled' }
