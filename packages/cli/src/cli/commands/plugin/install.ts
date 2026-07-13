import { installStaticPlugins } from '@alint-js/config'

import { defineCommand } from '../command'

interface PluginInstallOptions {
  config?: string
  registry?: string
}

export const install = defineCommand({
  action: async (context, options: PluginInstallOptions) => {
    const result = await installStaticPlugins({
      configFile: options.config,
      cwd: context.io.cwd,
      registry: options.registry,
    })

    if (result.configuredPluginCount === 0) {
      context.io.stdout.write('No static plugins configured. Wrote empty plugin lock.\n')
      return 0
    }

    context.io.stdout.write(`Installed packages: ${result.installedPackageCount}, local directories: ${result.installedLocalDirectoryCount}.\n`)
    return 0
  },
  description: 'Install plugins from static configs',
  examples: [
    [
      '# Install plugins referenced by static configs',
      'alint plugin install',
    ].join('\n'),
    [
      '# Install using a custom registry',
      'alint plugin install --registry https://registry.npmjs.org/',
    ].join('\n'),
    [
      '# Install a local directory configured as ./plugins/local-plugin',
      'alint plugin install',
    ].join('\n'),
  ],
  help: [
    'Install remote packages or local directories from static configs.',
    'Remote packages are extracted into the project plugin store. Local directories are installed in place. Both are recorded in `.alint/plugins/lock.json`.',
  ].join('\n\n'),
  name: 'install',
  options: [
    { description: 'Npm registry URL', flags: '--registry <url>' },
  ],
})
