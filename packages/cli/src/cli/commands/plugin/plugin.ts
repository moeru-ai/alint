import { defineCommand } from '../command'
import { install } from './install'

export const plugin = defineCommand({
  children: [
    install,
  ],
  description: 'Manage static config plugins',
  examples: [
    'alint plugin install',
  ],
  help: [
    'Manage static config plugins.',
    'Download versioned plugin packages used by static alint config files.',
    'Plugin install downloads npm package tarballs into .alint/plugins without running npm install or resolving transitive dependencies.',
  ].join('\n\n'),
  name: 'plugin',
})
