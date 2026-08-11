import { config } from './config'
import { lint } from './lint'
import { lsp } from './lsp'
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
  lsp,
  lint,
]

export { registerCommandTree } from './command'
