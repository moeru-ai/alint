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
  help: [
    'Inspect, list, and probe model entries from alint setup configuration.',
    'Model entries describe the provider/model ids alint can use for model-backed rules. Probe endpoints before saving them when you want to verify what model ids a provider exposes.',
  ].join('\n\n'),
  name: 'models',
})
