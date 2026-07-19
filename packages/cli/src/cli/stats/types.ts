export interface RunRuleCounts {
  cached: number
  cancelled: number
  completed: number
  failed: number
  planned: number
}

export interface RunStat extends RunStatInput {
  ts: number
}

export interface RunStatInput {
  cwd: string
  durationMs?: number
  ruleCounts: RunRuleCounts
  usage: RunStatUsage
}

export interface RunStatUsage {
  inTok: number
  outTok: number
  records: StatsUsageRecord[]
  totalTok: number
}

export interface StatsAggregate {
  dimension: StatsDimension
  rows: StatsGroupRow[]
  totalIn: number
  totalOut: number
  totalRuns: number
  totalTok: number
}

export interface StatsBucket extends StatsGroupRow {
  startMs: number
}

export type StatsDimension = 'dir' | 'model' | 'operation' | 'rule'

export interface StatsFilter {
  cwd?: string
  /** When set, keep only runs touching these rules and count only their records. */
  rules?: string[]
  since?: string
}

export interface StatsGroupRow {
  inTok: number
  /** Dimension value (rule, model, etc.) for a table row, or the date label for a bucket. */
  key: string
  outTok: number
  runs: number
  totalTok: number
}

export type StatsInterval = 'day' | 'month' | 'week'

/** Which measure the chart bars and the table sort rank by. */
export type StatsMetric = 'runs' | 'tokens'

export interface StatsQuery extends StatsFilter {
  by?: StatsDimension
}

/** Usage bucketed over time for the `--chart` timeline. */
export interface StatsSeries {
  buckets: StatsBucket[]
  interval: StatsInterval
  totalIn: number
  totalOut: number
  totalRuns: number
  totalTok: number
}

export interface StatsSeriesQuery extends StatsFilter {
  interval?: StatsInterval
}

export interface StatsStore {
  query: (filter?: StatsQuery) => Promise<StatsAggregate>
  querySeries: (filter?: StatsSeriesQuery) => Promise<StatsSeries>
  record: (input: RunStatInput) => Promise<void>
}

export interface StatsUsageRecord {
  filePath?: string
  inTok: number
  modelId: string
  operation?: string
  outTok: number
  providerId: string
  ruleId: string
  totalTok: number
}
