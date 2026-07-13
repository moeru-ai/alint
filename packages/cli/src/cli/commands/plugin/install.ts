import { installStaticPlugins } from '@alint-js/config'

import { defineCommand } from '../command'

interface InstallSummaryCounts {
  installedRegistryCount: number
  registeredDirectoryCount: number
}

interface PluginInstallOptions {
  config?: string
  registry?: string
}

function formatInstallSummary(counts: InstallSummaryCounts): string {
  const clauses: string[] = []

  if (counts.installedRegistryCount > 0) {
    const packageLabel = counts.installedRegistryCount === 1 ? 'package' : 'packages'
    clauses.push(`Installed ${counts.installedRegistryCount} registry plugin ${packageLabel}`)
  }

  if (counts.registeredDirectoryCount > 0) {
    const directoryLabel = counts.registeredDirectoryCount === 1 ? 'directory' : 'directories'
    clauses.push(`registered ${counts.registeredDirectoryCount} local plugin ${directoryLabel}`)
  }

  const summary = clauses.join(' and ')
  if (summary === '') {
    return ''
  }

  return `${summary.charAt(0).toUpperCase()}${summary.slice(1)}.\n`
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

    context.io.stdout.write(formatInstallSummary(result))
    return 0
  },
  description: 'Install or register static plugins',
  examples: [
    [
      '# Install or register plugins referenced by static config',
      'alint plugin install',
    ].join('\n'),
    [
      '# Install using a custom registry',
      'alint plugin install --registry https://registry.npmjs.org/',
    ].join('\n'),
    [
      '# Register a local directory configured as ./plugins/local-plugin',
      'alint plugin install',
    ].join('\n'),
  ],
  help: [
    'Install registry packages and register local directories referenced by static config plugin strings.',
    'Registry packages are extracted into the project plugin store. Local directory paths are registered in place. Both are recorded in `.alint/plugins/lock.json`.',
  ].join('\n\n'),
  name: 'install',
  options: [
    { description: 'Npm registry URL', flags: '--registry <url>' },
  ],
})
