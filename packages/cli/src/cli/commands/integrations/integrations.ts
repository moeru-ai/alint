import { defineCommand } from '../command'
import { stopGate } from './stop-gate/stop-gate'

export const integrations = defineCommand({
  children: [stopGate],
  description: 'Run external integrations',
  name: 'integrations',
})
