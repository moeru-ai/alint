import { config } from './config'
import { lint } from './lint'
import { output } from './output-inspect'
import { setup } from './setup'

export const commandTree = [
  setup,
  config,
  output,
  lint,
]

export { registerCommandTree } from './command'
