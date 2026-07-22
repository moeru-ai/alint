import { defineCommand } from '../command'
import { inspect } from './inspect'
import { models } from './models'
import { providers } from './providers'

export const config = defineCommand({
  children: [
    inspect,
    models,
    providers,
  ],
  description: 'Manage alint configuration',
  examples: [
    [
      '# Show the effective alint config for a file',
      'alint config inspect src/index.ts',
    ].join('\n'),
    [
      '# Inspect a file using a custom config path',
      'alint --config alint.config.ts config inspect src/index.ts',
    ].join('\n'),
    [
      '# List configured providers and models',
      'alint config providers list',
      'alint config models list',
    ].join('\n'),
    [
      '# Show one configured provider or model by id',
      'alint config providers show openrouter',
      'alint config models show z-ai/glm-5.2',
    ].join('\n'),
    [
      '# Probe an OpenAI-compatible endpoint before saving it',
      'alint config providers probe --endpoint https://openrouter.ai/api/v1',
      'alint config models probe --endpoint https://openrouter.ai/api/v1',
    ].join('\n'),
    [
      '# Update a provider without removing its configured models',
      'alint config providers update --provider openrouter',
    ].join('\n'),
    [
      '# Remove one model or prune models missing from a provider',
      'alint config models rm qwen --provider ollama',
      'alint config models prune --provider ollama -N --yes',
    ].join('\n'),
  ],
  help: [
    'Inspect and update alint setup/configuration state.',
    'Use these commands to understand the effective config for a file, inspect saved provider/model setup, and probe OpenAI-compatible endpoints before using them in model-backed rules.',
    'Configuration writes use global scope by default. Pass --local to read and write the current project\'s .alint/config.toml instead.',
    'Provider updates are additive. Model pruning is destructive and requires confirmation.',
  ].join('\n\n'),
  name: 'config',
})
