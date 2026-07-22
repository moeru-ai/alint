import { defineCommand } from '../../command'
import { ls } from './ls'
import { probe } from './probe'
import { prune } from './prune'
import { rm } from './rm'
import { show } from './show'

export const models = defineCommand({
  children: [
    probe,
    prune,
    ls,
    show,
    rm,
  ],
  description: 'Manage configured models',
  examples: [
    [
      '# Remove an exact model from one provider',
      'alint config models rm qwen --provider ollama',
    ].join('\n'),
    [
      '# Destructively remove models no longer reported by one provider',
      'alint config models prune --provider ollama -N --yes',
    ].join('\n'),
  ],
  help: [
    'Inspect, list, and probe model entries from alint setup configuration. Remove exact entries when they are no longer needed.',
    'Model entries describe the provider/model ids alint can use for model-backed rules. Probe endpoints before saving them when you want to verify what model ids a provider exposes.',
    'Use a provider-qualified model such as ollama/qwen or pass --provider ollama when the same model id is configured for multiple providers.',
    'Prune is destructive: it removes configured models absent from the provider response. Non-interactive pruning requires -N --yes.',
    'Writes use global scope by default. Pass --local to select the current project\'s setup configuration.',
  ].join('\n\n'),
  name: 'models',
})
