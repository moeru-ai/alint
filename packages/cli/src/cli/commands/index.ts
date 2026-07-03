import { config } from './config'
import { lint } from './lint'
import { setup } from './setup'

export const commandTree = [
  setup,
  config,
  lint,
]

export { registerCommandTree } from './command'
