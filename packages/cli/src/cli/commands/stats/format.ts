import type { StatsAggregate, StatsDimension } from '../../stats'

import { createColors } from 'tinyrainbow'

export interface FormatStatsOptions {
  color?: boolean
}

export const colors = createColors({ force: true })

export const DIMENSION_LABEL: Record<StatsDimension, string> = {
  dir: 'directory',
  model: 'model',
  operation: 'operation',
  rule: 'rule',
}

export function formatStatsAggregate(aggregate: StatsAggregate, options: FormatStatsOptions = {}): string {
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

  const header = [DIMENSION_LABEL[aggregate.dimension], 'runs', 'input', 'output', 'total']
  const rows = aggregate.rows.map(row => [
    row.key,
    String(row.runs),
    formatTokens(row.inTok),
    formatTokens(row.outTok),
    formatTokens(row.totalTok),
  ])
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map(row => row[index].length)))
  const renderRow = (cells: string[], isHeader: boolean): string =>
    cells
      .map((cell, index) => {
        const aligned = index === 0 ? cell.padEnd(widths[index]) : cell.padStart(widths[index])

        return isHeader ? paint(aligned, colors.bold) : aligned
      })
      .join('  ')

  lines.push(renderRow(header, true), ...rows.map(row => renderRow(row, false)))

  return `${lines.join('\n')}\n`
}

export function formatTokens(value: number): string {
  return value.toLocaleString('en-US')
}
