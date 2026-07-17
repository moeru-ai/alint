import type { StatsAggregate } from '../../stats'
import type { FormatStatsOptions } from './format'

import { colors, DIMENSION_LABEL, formatTokens } from './format'

const BAR_WIDTH = 32

const FULL_BLOCK = '█'
const PARTIAL_BLOCKS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

export function formatStatsChart(aggregate: StatsAggregate, options: FormatStatsOptions = {}): string {
  const paint = (text: string, style: (value: string) => string): string =>
    options.color === true ? style(text) : text
  const runLabel = aggregate.totalRuns === 1 ? 'run' : 'runs'
  const lines = [
    `${aggregate.totalRuns} ${runLabel} — ${formatTokens(aggregate.totalIn)} in / ${formatTokens(aggregate.totalOut)} out / ${paint(`${formatTokens(aggregate.totalTok)} total`, colors.cyan)}`,
    '',
  ]

  if (aggregate.rows.length === 0) {
    lines.push('No stats recorded yet.')

    return `${lines.join('\n')}\n`
  }

  const maxTok = Math.max(...aggregate.rows.map(row => row.totalTok))
  const label = DIMENSION_LABEL[aggregate.dimension]
  const keyWidth = Math.max(label.length, ...aggregate.rows.map(row => row.key.length))
  const values = aggregate.rows.map(row => formatTokens(row.totalTok))
  const valueWidth = Math.max('total'.length, ...values.map(value => value.length))

  lines.push(paint(
    `${label.padEnd(keyWidth)}  ${' '.repeat(BAR_WIDTH)}  ${'total'.padStart(valueWidth)}  share`,
    colors.bold,
  ))

  aggregate.rows.forEach((row, index) => {
    const bar = renderBar(maxTok === 0 ? 0 : row.totalTok / maxTok)
    const share = aggregate.totalTok === 0 ? 0 : (row.totalTok / aggregate.totalTok) * 100

    lines.push(
      `${row.key.padEnd(keyWidth)}  ${paint(bar, colors.cyan)}  ${values[index].padStart(valueWidth)}  ${share.toFixed(1).padStart(5)}%`,
    )
  })

  return `${lines.join('\n')}\n`
}

function renderBar(fraction: number): string {
  const eighths = fraction <= 0 ? 0 : Math.max(1, Math.round(fraction * BAR_WIDTH * 8))
  const full = Math.floor(eighths / 8)
  const remainder = eighths % 8

  return `${FULL_BLOCK.repeat(full)}${PARTIAL_BLOCKS[remainder]}`.padEnd(BAR_WIDTH)
}
