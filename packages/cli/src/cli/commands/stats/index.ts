import type { StatsCommandOptions } from './options'

import { defineCommand } from '../command'
import { runStatsCommand } from './stats'

export const stats = defineCommand({
  action: (context, options: StatsCommandOptions) => runStatsCommand(options, context.io),
  description: 'Show recorded run stats',
  name: 'stats',
  options: [
    { description: 'Render a usage timeline instead of the table', flags: '--chart' },
    { description: 'Group the table by rule, operation, model, or dir', flags: '--by <dimension>' },
    { description: 'Chart bucket: day, week, or month (default: auto)', flags: '--interval <interval>' },
    { description: 'Draw the chart as vertical bars instead of horizontal', flags: '--vertical' },
    { description: 'Rank/plot by tokens or runs', flags: '--metric <metric>' },
    { description: 'Only include these rules (comma-separated)', flags: '--rule <ids>' },
    { description: 'Only include runs since this time (e.g. 24h, 7d, 4w, 3m, 2025-01)', flags: '--since <time>' },
    { description: 'Only include runs from this directory', flags: '--cwd <path>' },
    { description: 'Only include runs from the current directory', flags: '--here' },
    { description: 'Show full counts instead of compact k/M/B', flags: '--exact-numbers' },
    { description: 'Output JSON', flags: '--json' },
  ],
})
