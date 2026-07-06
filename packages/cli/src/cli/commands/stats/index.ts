import type { StatsCommandOptions } from './options'

import { defineCommand } from '../command'
import { runStatsCommand } from './stats'

export const stats = defineCommand({
  action: (context, options: StatsCommandOptions) => runStatsCommand(options, context.io),
  description: 'Show recorded run stats',
  name: 'stats',
  options: [
    { description: 'Group by rule, operation, model, or dir', flags: '--by <dimension>' },
    { description: 'Only include runs since this time (e.g. 7d, 24h, 2025-01)', flags: '--since <spec>' },
    { description: 'Only include runs from this directory', flags: '--cwd <path>' },
    { description: 'Only include runs from the current directory', flags: '--here' },
    { description: 'Output JSON', flags: '--json' },
  ],
})
