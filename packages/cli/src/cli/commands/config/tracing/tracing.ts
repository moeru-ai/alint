import { defineCommand } from '../../command'
import { enable } from './enable'

export const tracing = defineCommand({
  children: [enable],
  description: 'Manage OpenTelemetry tracing',
  help: [
    'Configure tracing in alint setup configuration.',
    'Tracing is disabled until enabled. The default output directory is .alint/traces.',
    'Writes use global scope by default. Pass --local to select the current project\'s setup configuration.',
  ].join('\n\n'),
  name: 'tracing',
})
