import { defineCommand } from '../command'
import { inspect } from './inspect'

export const output = defineCommand({
  children: [
    inspect,
  ],
  description: 'Inspect alint output files',
  help: [
    'Inspect saved alint run outputs without rerunning rules or model calls.',
    'Use this when you already have JSON from `alint --format json` and want to render, validate, or transform that result for humans or tools.',
  ].join('\n\n'),
  name: 'output',
})
