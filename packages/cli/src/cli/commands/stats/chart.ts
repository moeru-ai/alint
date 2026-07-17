import type { StatsAggregate } from '../../stats'
import type { FormatStatsOptions } from './format'

import { colors, DIMENSION_LABEL, formatMetric, METRIC_LABEL, metricValue, sortRows, summaryLine } from './format'

const BAR_WIDTH = 32

const FULL_BLOCK = '█'
const PARTIAL_BLOCKS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

export function formatStatsChart(aggregate: StatsAggregate, options: FormatStatsOptions = {}): string {
  const paint = (text: string, style: (value: string) => string): string =>
    options.color === true ? style(text) : text
  const metric = options.metric ?? 'tokens'
  const lines = [summaryLine(aggregate, paint), '']

  if (aggregate.rows.length === 0) {
    lines.push('No stats recorded yet.')

    return `${lines.join('\n')}\n`
  }

  const rows = sortRows(aggregate.rows, metric)

  const maxValue = Math.max(...rows.map(row => metricValue(row, metric)))
  const columnTotal = rows.reduce((sum, row) => sum + metricValue(row, metric), 0)
  const label = DIMENSION_LABEL[aggregate.dimension]
  const valueLabel = METRIC_LABEL[metric]
  const keyWidth = Math.max(label.length, ...rows.map(row => row.key.length))
  const values = rows.map(row => formatMetric(row, metric))
  const valueWidth = Math.max(valueLabel.length, ...values.map(value => value.length))

  lines.push(paint(
    `${label.padEnd(keyWidth)}  ${' '.repeat(BAR_WIDTH)}  ${valueLabel.padStart(valueWidth)}  share`,
    colors.bold,
  ))

  rows.forEach((row, index) => {
    const value = metricValue(row, metric)
    const bar = renderBar(maxValue === 0 ? 0 : value / maxValue)
    const share = columnTotal === 0 ? 0 : (value / columnTotal) * 100

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
