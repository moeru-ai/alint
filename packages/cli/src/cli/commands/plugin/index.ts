import { defineCommand } from '../command'
import { install } from './install'

export const plugin = defineCommand({
  children: [
    install,
  ],
  description: 'Manage static plugins',
  examples: [
    [
      '# Install packages or register local directories from static config',
      'alint plugin install',
    ].join('\n'),
    [
      '# Register a local plugin directory path in alint.config.toml',
      '[[config.group]]',
      '[config.group.plugins]',
      'local = "./plugins/local-plugin"',
    ].join('\n'),
  ],
  help: [
    'Install registry packages and register live local plugin directories.',
    'Use `plugin install` after adding plugin source specifiers to static config.',
  ].join('\n\n'),
  name: 'plugin',
})
