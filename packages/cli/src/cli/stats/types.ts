export interface RuleDuration {
  durationMs: number
  ruleId: string
}

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
  ruleDurations?: RuleDuration[]
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
  totalDuration?: number
  totalIn: number
  totalOut: number
  totalRuns: number
  totalTok: number
}

export type StatsDimension = 'dir' | 'model' | 'operation' | 'rule'

export interface StatsGroupRow {
  durationMs?: number
  inTok: number
  key: string
  outTok: number
  runs: number
  totalTok: number
}

export interface StatsQuery {
  by?: StatsDimension
  cwd?: string
  since?: string
}

export interface StatsStore {
  query: (filter?: StatsQuery) => Promise<StatsAggregate>
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
