import { defineCommand } from '../command'
import { install } from './install'

export const plugin = defineCommand({
  children: [
    install,
  ],
  description: 'Manage static plugins',
  examples: [
    [
      '# Install packages referenced by static config plugins',
      'alint plugin install',
    ].join('\n'),
  ],
  help: [
    'Install and manage static plugin packages.',
    'Use `plugin install` after adding plugin package specifiers to static config.',
  ].join('\n\n'),
  name: 'plugin',
})
