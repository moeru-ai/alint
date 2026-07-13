import { defineCommand } from '../command'
import { install } from './install'

export const plugin = defineCommand({
  children: [
    install,
  ],
  description: 'Install remote packages or local directories from static configs',
  examples: [
    [
      '# Install remote packages or local directories from static configs',
      'alint plugin install',
    ].join('\n'),
    [
      '# Install a local plugin directory from alint.config.toml',
      '[[config.group]]',
      '[config.group.plugins]',
      'local = "./plugins/local-plugin"',
    ].join('\n'),
  ],
  help: [
    'Install remote packages or local directories from static configs.',
    'Use `plugin install` after adding or changing plugin sources.',
  ].join('\n\n'),
  name: 'plugin',
})
