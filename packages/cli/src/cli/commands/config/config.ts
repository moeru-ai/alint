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
  ],
  help: [
    'Inspect and update alint setup/configuration state.',
    'Use these commands to understand the effective config for a file, inspect saved provider/model setup, and probe OpenAI-compatible endpoints before using them in model-backed rules.',
  ].join('\n\n'),
  name: 'config',
})
