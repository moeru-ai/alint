export interface StatsCommandOptions {
  by?: string
  chart?: boolean
  cwd?: string
  here?: boolean
  json?: boolean
  metric?: string
  since?: string
}

export type StatsMetric = 'duration' | 'runs' | 'tokens'
