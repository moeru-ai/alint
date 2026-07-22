import { defineCommand } from '../../command'
import { ls } from './ls'
import { probe } from './probe'
import { set } from './set'
import { show } from './show'
import { unset } from './unset'
import { update } from './update'

export const providers = defineCommand({
  children: [
    ls,
    show,
    probe,
    update,
    set,
    unset,
  ],
  description: 'Manage configured providers',
  examples: [
    [
      '# Probe and add newly reported models',
      'alint config providers update --provider openrouter',
    ].join('\n'),
    [
      '# Set or unset one provider header',
      'alint config providers set --provider openrouter headers.Authorization "Bearer $TOKEN"',
      'alint config providers unset --provider openrouter headers.Authorization',
    ].join('\n'),
  ],
  help: [
    'Inspect and edit providers in alint setup configuration.',
    'Provider update is additive by default. It does not automatically remove a configured model merely because the remote provider no longer reports it.',
    'Deselecting a configured model in the interactive TUI removes it when you confirm the update. Use the destructive config models prune command to remove configured models absent from provider responses.',
    'Writes use global scope by default. Pass --local to select the current project\'s setup configuration.',
    'Header values passed as command arguments may remain in shell history. Use environment-variable placeholders such as $TOKEN instead of literal secrets.',
  ].join('\n\n'),
  name: 'providers',
})
