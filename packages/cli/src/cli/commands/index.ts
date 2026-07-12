import { config } from './config'
import { lint } from './lint'
import { output } from './output-inspect'
import { plugin } from './plugin'
import { setup } from './setup'
import { stats } from './stats'

export const commandTree = [
  setup,
  config,
  plugin,
  output,
  stats,
  lint,
]

export { registerCommandTree } from './command'
