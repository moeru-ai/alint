import { defineCommand } from '../../command'
import { stopGate } from './stop-gate'

export const integrations = defineCommand({
  children: [stopGate],
  description: 'Manage external integration configuration',
  name: 'integrations',
})
