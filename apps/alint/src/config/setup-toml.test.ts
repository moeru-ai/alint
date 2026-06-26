import { describe, expect, it } from 'vitest'

import { parseSetupConfigToml, stringifySetupConfigToml } from './setup-toml'

describe('setup TOML registry', () => {
  it('parses provider model fields from snake_case TOML', () => {
    const apiKeyVariable = '$' + '{OLLAMA_API_KEY}'
    const config = parseSetupConfigToml(`
version = 1

[[providers]]
id = "ollama"
type = "openai-compatible"
endpoint = "http://localhost:11434/v1"

[providers.headers]
Authorization = "Bearer ${apiKeyVariable}"

[[providers.models]]
id = "local:qwen-8b"
name = "qwen:8b"
aliases = ["default", "local"]
capabilities = ["code-review", "structured-output"]
size = "small"
context_window = 32768

[providers.models.default_params]
temperature = 0.1
max_tokens = 2048
`)

    expect(config).toEqual({
      providers: [
        {
          endpoint: 'http://localhost:11434/v1',
          headers: {
            Authorization: `Bearer ${apiKeyVariable}`,
          },
          id: 'ollama',
          models: [
            {
              aliases: ['default', 'local'],
              capabilities: ['code-review', 'structured-output'],
              contextWindow: 32768,
              defaultParams: {
                max_tokens: 2048,
                temperature: 0.1,
              },
              id: 'local:qwen-8b',
              name: 'qwen:8b',
              size: 'small',
            },
          ],
          type: 'openai-compatible',
        },
      ],
      version: 1,
    })
  })

  it('stringifies camelCase model fields to snake_case TOML', () => {
    const toml = stringifySetupConfigToml({
      providers: [
        {
          endpoint: 'http://localhost:11434/v1',
          id: 'ollama',
          models: [
            {
              contextWindow: 32768,
              defaultParams: {
                temperature: 0.1,
              },
              id: 'local:qwen-8b',
              name: 'qwen:8b',
            },
          ],
          type: 'openai-compatible',
        },
      ],
      version: 1,
    })

    expect(toml).toContain('context_window = 32768')
    expect(toml).toContain('[providers.models.default_params]')
    expect(toml).toContain('temperature = 0.1')
  })

  it('parses runner settings from setup TOML', () => {
    const config = parseSetupConfigToml(`
version = 1

[runner]
file_concurrency = 2
rule_concurrency = 1
timeout_ms = 120000

[[providers]]
id = "local"
type = "openai-compatible"
endpoint = "http://localhost:11434/v1"

[[providers.models]]
id = "qwen"
`)

    expect(config.runner).toEqual({
      fileConcurrency: 2,
      ruleConcurrency: 1,
      timeoutMs: 120000,
    })
  })

  it('stringifies runner settings to setup TOML', () => {
    const toml = stringifySetupConfigToml({
      providers: [
        {
          endpoint: 'http://localhost:11434/v1',
          id: 'local',
          models: [{ id: 'qwen' }],
          type: 'openai-compatible',
        },
      ],
      runner: {
        fileConcurrency: 2,
        ruleConcurrency: 1,
        timeoutMs: 120000,
      },
      version: 1,
    })

    expect(toml).toContain('[runner]')
    expect(toml).toContain('file_concurrency = 2')
    expect(toml).toContain('rule_concurrency = 1')
    expect(toml).toContain('timeout_ms = 120000')
  })

  it('rejects invalid runner settings', () => {
    expect(() => parseSetupConfigToml(`
version = 1

[runner]
file_concurrency = 0

[[providers]]
id = "local"
type = "openai-compatible"
endpoint = "http://localhost:11434/v1"

[[providers.models]]
id = "qwen"
`)).toThrow('Invalid runner file_concurrency: must be a positive integer.')
  })

  it('rejects invalid provider types', () => {
    expect(() => parseSetupConfigToml(`
version = 1
[[providers]]
id = "bad"
type = "unknown"
endpoint = "http://localhost:9999/v1"
`)).toThrow('Invalid provider "bad": type must be "openai-compatible".')
  })
})
