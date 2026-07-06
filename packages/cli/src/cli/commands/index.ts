import { config } from './config'
import { lint } from './lint'
import { output } from './output-inspect'
import { setup } from './setup'
import { stats } from './stats'

export const commandTree = [
  setup,
  config,
  output,
  stats,
  lint,
]

export { registerCommandTree } from './command'
