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

    if (result.referenceCount === 0) {
      context.io.stdout.write('No static plugin references found. Wrote empty plugin lock.\n')
      return 0
    }

    context.io.stdout.write(`Installed ${result.installedCount} static plugin package${result.installedCount === 1 ? '' : 's'}.\n`)
    return 0
  },
  description: 'Install static plugin packages',
  examples: [
    [
      '# Install plugin packages referenced by static config',
      'alint plugin install',
    ].join('\n'),
    [
      '# Install using a custom registry',
      'alint plugin install --registry https://registry.npmjs.org/',
    ].join('\n'),
  ],
  help: [
    'Install npm packages referenced by static config plugin strings.',
    'Packages are extracted into the project plugin store and recorded in `.alint/plugins/lock.json`.',
  ].join('\n\n'),
  name: 'install',
  options: [
    { description: 'Npm registry URL', flags: '--registry <url>' },
  ],
})
