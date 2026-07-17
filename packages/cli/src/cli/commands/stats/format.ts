import type { StatsAggregate, StatsDimension, StatsGroupRow } from '../../stats'
import type { StatsMetric } from './options'

import { createColors } from 'tinyrainbow'

export interface FormatStatsOptions {
  color?: boolean
  metric?: StatsMetric
}

export type Paint = (text: string, style: (value: string) => string) => string

export const colors = createColors({ force: true })

export const DIMENSION_LABEL: Record<StatsDimension, string> = {
  dir: 'directory',
  model: 'model',
  operation: 'operation',
  rule: 'rule',
}

export const METRIC_LABEL: Record<StatsMetric, string> = {
  duration: 'time',
  runs: 'runs',
  tokens: 'total',
}

export function formatMetric(row: StatsGroupRow, metric: StatsMetric): string {
  if (metric === 'runs') {
    return String(row.runs)
  }

  if (metric === 'duration') {
    return formatDuration(row.durationMs)
  }

  return formatTokens(row.totalTok)
}

export function formatStatsAggregate(aggregate: StatsAggregate, options: FormatStatsOptions = {}): string {
  const paint: Paint = (text, style) => options.color === true ? style(text) : text
  const metric = options.metric ?? 'tokens'
  const lines = [summaryLine(aggregate, paint), '']

  if (aggregate.rows.length === 0) {
    lines.push('No stats recorded yet.')

    return `${lines.join('\n')}\n`
  }

  // The rule view always carries a time column so duration is visible without
  // selecting a metric; other dimensions have no per-row duration to show.
  const withTime = aggregate.dimension === 'rule'
  const header = [DIMENSION_LABEL[aggregate.dimension], 'runs', 'input', 'output', 'total']

  if (withTime) {
    header.push('time')
  }

  const rows = sortRows(aggregate.rows, metric).map((row) => {
    const cells = [
      row.key,
      String(row.runs),
      formatTokens(row.inTok),
      formatTokens(row.outTok),
      formatTokens(row.totalTok),
    ]

    if (withTime) {
      cells.push(formatDuration(row.durationMs))
    }

    return cells
  })
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

export function metricValue(row: StatsGroupRow, metric: StatsMetric): number {
  if (metric === 'runs') {
    return row.runs
  }

  if (metric === 'duration') {
    return row.durationMs ?? 0
  }

  return row.totalTok
}

export function sortRows(rows: StatsGroupRow[], metric: StatsMetric): StatsGroupRow[] {
  return [...rows].sort((left, right) => metricValue(right, metric) - metricValue(left, metric))
}

export function summaryLine(aggregate: StatsAggregate, paint: Paint): string {
  const runLabel = aggregate.totalRuns === 1 ? 'run' : 'runs'
  const time = aggregate.totalDuration === undefined ? '' : ` / ${formatDuration(aggregate.totalDuration)} time`

  return `${aggregate.totalRuns} ${runLabel} — ${formatTokens(aggregate.totalIn)} in / ${formatTokens(aggregate.totalOut)} out / ${paint(`${formatTokens(aggregate.totalTok)} total`, colors.cyan)}${time}`
}

function formatDuration(ms: number | undefined): string {
  return ms === undefined ? '—' : `${(Math.max(ms, 0) / 1000).toFixed(1)}s`
}
