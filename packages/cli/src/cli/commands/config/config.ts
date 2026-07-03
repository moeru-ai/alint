import { defineCommand } from '../command'
import { inspect } from './inspect'
import { models } from './models'
import { providers } from './providers'

export const config = defineCommand({
  children: [
    inspect,
    models,
    providers,
  ],
  description: 'Manage alint configuration',
  name: 'config',
})
