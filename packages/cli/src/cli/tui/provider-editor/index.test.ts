import type { ProviderDefinition, SetupConfig } from '@alint-js/config'

import type { ModelOption, ProviderEditorPromptPort } from './types'

import { describe, expect, it, vi } from 'vitest'

import { runProviderEditor } from './index'

const io = {
  cwd: '/workspace',
  stderr: { write: vi.fn() },
  stdout: { write: vi.fn() },
}

const source = {
  label: 'Custom OpenAI-compatible provider',
  probeModels: true,
  value: 'custom' as const,
}

const existingProvider: ProviderDefinition = {
  endpoint: 'https://old.example/v1',
  headers: {
    'Authorization': 'Bearer old-secret',
    'X-Keep': 'yes',
  },
  id: 'example',
  models: [
    {
      aliases: ['fast'],
      capabilities: ['code-review'],
      contextWindow: 32768,
      defaultParams: { temperature: 0.1 },
      id: 'existing',
      name: 'Existing',
      size: 'small',
    },
    { aliases: ['default'], id: 'missing', name: 'Missing' },
  ],
  type: 'openai-compatible',
}

const config: SetupConfig = {
  providers: [existingProvider],
  version: 1,
}

function createPromptPort(overrides: Partial<ProviderEditorPromptPort> = {}): ProviderEditorPromptPort {
  return {
    confirm: vi.fn(async (): Promise<'yes'> => 'yes'),
    defaultAction: vi.fn(async (): Promise<'no'> => 'no'),
    defaultModel: vi.fn(async () => 'cancelled'),
    endpoint: vi.fn(async () => 'https://next.example/v1'),
    headerInput: vi.fn(async () => 'Authorization=Bearer replacement'),
    manualModels: vi.fn(async () => ['manual']),
    models: vi.fn(async (_options, initialValues) => [...initialValues]),
    probe: vi.fn(async () => ['existing', 'new']),
    providerId: vi.fn(async initialValue => initialValue),
    retainedHeaders: vi.fn(async names => names),
    ...overrides,
  }
}

describe('runProviderEditor', () => {
  it('updates a provider without exposing secret values in prompts or the summary', async () => {
    const summaries: string[] = []
    const promptPort = createPromptPort({
      confirm: vi.fn(async (summary: string): Promise<'yes'> => {
        summaries.push(summary)
        return 'yes'
      }),
    })

    const result = await runProviderEditor({
      config,
      existingProvider,
      io,
      mode: 'update',
      source,
    }, promptPort)

    expect(result.status).toBe('confirmed')
    if (result.status !== 'confirmed') {
      return
    }

    expect(result.provider.endpoint).toBe('https://next.example/v1')
    expect(result.provider.headers).toEqual({
      'Authorization': 'Bearer replacement',
      'X-Keep': 'yes',
    })
    expect(result.provider.models[0]).toEqual(existingProvider.models[0])
    expect(result.provider.models.at(-1)).toEqual({ id: 'new', name: 'new' })
    expect(promptPort.providerId).toHaveBeenCalledWith('example', false)
    expect(promptPort.headerInput).toHaveBeenCalledWith()
    expect(summaries[0]).toContain('Headers: Authorization, X-Keep')
    expect(summaries[0]).toContain('Added models: new')
    expect(summaries[0]).not.toContain('old-secret')
    expect(summaries[0]).not.toContain('replacement')
  })

  it('returns cancellation without producing a provider', async () => {
    const result = await runProviderEditor({
      config,
      existingProvider,
      io,
      mode: 'update',
      source,
    }, createPromptPort({ endpoint: vi.fn(async () => 'cancelled') }))

    expect(result).toEqual({ status: 'cancelled' })
  })

  it('returns Back from the first editor prompt to its caller', async () => {
    const promptPort = createPromptPort({ endpoint: vi.fn(async () => 'back') })

    const result = await runProviderEditor({
      config,
      existingProvider,
      io,
      mode: 'update',
      source,
    }, promptPort)

    expect(result).toEqual({ status: 'back' })
    expect(promptPort.providerId).not.toHaveBeenCalled()
  })

  it('initially selects configured models missing from the remote response', async () => {
    const promptPort = createPromptPort()

    await runProviderEditor({
      config,
      existingProvider,
      io,
      mode: 'update',
      source,
    }, promptPort)

    expect(promptPort.models).toHaveBeenCalledWith([
      { hint: undefined, label: 'existing', value: 'existing' },
      { hint: 'not reported by provider', label: 'missing', value: 'missing' },
      { hint: 'new', label: 'new', value: 'new' },
    ], ['existing', 'missing', 'new'])
  })

  it('forces replacement of a current default that is deselected', async () => {
    const promptPort = createPromptPort({
      defaultModel: vi.fn(async (options: ModelOption[]) => options.find(option => option.value.includes('existing'))?.value ?? 'cancelled'),
      models: vi.fn(async () => ['existing', 'new']),
    })

    const result = await runProviderEditor({
      config,
      existingProvider,
      io,
      mode: 'update',
      source,
    }, promptPort)

    expect(promptPort.defaultModel).toHaveBeenCalledOnce()
    expect(result).toMatchObject({
      defaultAliasTarget: { modelId: 'existing', providerId: 'example' },
      status: 'confirmed',
    })
  })

  it('uses manual entry without probing when the setup source disables probes', async () => {
    const promptPort = createPromptPort()

    await runProviderEditor({
      config: { providers: [], version: 1 },
      io,
      mode: 'create',
      source: { label: 'Manual model entry', probeModels: false, value: 'manual' },
    }, promptPort)

    expect(promptPort.probe).not.toHaveBeenCalled()
    expect(promptPort.manualModels).toHaveBeenCalledOnce()
  })

  it('derives the create provider id and offers scoped-config defaults from a provisional config', async () => {
    const promptPort = createPromptPort({
      defaultAction: vi.fn(async (): Promise<'selectAnother'> => 'selectAnother'),
      defaultModel: vi.fn(async (options: ModelOption[]) => options.find(option => option.value.includes('remote'))?.value ?? 'cancelled'),
      endpoint: vi.fn(async () => 'http://127.0.0.1:8317/v1'),
      headerInput: vi.fn(async () => ''),
      probe: vi.fn(async () => ['remote']),
    })

    const result = await runProviderEditor({
      config: {
        providers: [{
          endpoint: 'https://other.example/v1',
          id: 'other',
          models: [{ aliases: ['default'], id: 'existing-default', name: 'Existing default' }],
          type: 'openai-compatible',
        }],
        version: 1,
      },
      io,
      mode: 'create',
      source: {
        defaultEndpoint: 'http://127.0.0.1:8317/v1',
        defaultProviderId: 'CLIProxyAPI',
        label: 'CLIProxyAPI',
        probeModels: true,
        value: 'cliProxyApi',
      },
    }, promptPort)

    expect(promptPort.providerId).toHaveBeenCalledWith('cliproxyapi', true)
    expect(promptPort.defaultModel).toHaveBeenCalledWith([
      { hint: 'current default', label: 'other / existing-default', value: 'other\u0000existing-default' },
      { hint: 'new', label: 'cliproxyapi / remote', value: 'cliproxyapi\u0000remote' },
    ])
    expect(result).toMatchObject({
      defaultAliasTarget: { modelId: 'remote', providerId: 'cliproxyapi' },
      status: 'confirmed',
    })
  })
})
