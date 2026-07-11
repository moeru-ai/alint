import { defineCommand } from '../command'
import { install } from './install'
import { verify } from './verify'

export const plugin = defineCommand({
  children: [
    install,
    verify,
  ],
  description: 'Manage static config plugins',
  examples: [
    'alint plugin install',
    'alint plugin verify ./plugin-package.tgz',
  ],
  help: [
    'Manage static config plugins.',
    'Download and verify versioned plugin packages used by static alint config files.',
    'Plugin install downloads npm package tarballs into .alint/plugins without running npm install or resolving transitive dependencies.',
  ].join('\n\n'),
  name: 'plugin',
})
