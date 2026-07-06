import type {
  RunStat,
  RunStatInput,
  StatsAggregate,
  StatsDimension,
  StatsGroupRow,
  StatsQuery,
  StatsStore,
  StatsUsageRecord,
} from './types'

import { appendFile, mkdir, readdir, readFile, rm } from 'node:fs/promises'

import { join } from 'pathe'

import { parseSince } from './since'

const DEFAULT_RETENTION_MONTHS = 12
const STATS_FILE_PATTERN = /^stats-(\d{4})-(\d{2})\.jsonl$/u

export interface JsonlStatsStoreOptions {
  clock?: () => number
  dir: string
  retentionMonths?: number
}

// JSONL-backed stats store: one line per run in monthly-rotated files under `options.dir`.
export function createJsonlStatsStore(options: JsonlStatsStoreOptions): StatsStore {
  const now = options.clock ?? Date.now
  const retentionMonths = options.retentionMonths ?? DEFAULT_RETENTION_MONTHS

  return {
    query: filter => query(options.dir, filter ?? {}, now),
    record: input => record(options.dir, input, now(), retentionMonths),
  }
}

function accumulate(
  rows: Map<string, StatsGroupRow>,
  key: string,
  inTok: number,
  outTok: number,
  totalTok: number,
  countRun: boolean,
): void {
  const row = rows.get(key) ?? { inTok: 0, key, outTok: 0, runs: 0, totalTok: 0 }

  row.inTok += inTok
  row.outTok += outTok
  row.totalTok += totalTok

  if (countRun) {
    row.runs += 1
  }

  rows.set(key, row)
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function monthIndexOf(ts: number): number {
  const date = new Date(ts)

  return date.getUTCFullYear() * 12 + date.getUTCMonth()
}

function parseRunLine(line: string): RunStat | undefined {
  try {
    const value = JSON.parse(line) as Partial<RunStat>

    // Skip any records not shaped like a run.
    if (typeof value.ts === 'number' && typeof value.cwd === 'string' && value.usage != null) {
      return value as RunStat
    }

    return undefined
  }
  catch {
    return undefined
  }
}

async function prune(dir: string, ts: number, retentionMonths: number): Promise<void> {
  if (retentionMonths <= 0) {
    return
  }

  // Keep the newest `retentionMonths` months inclusive and drop files strictly older.
  const cutoff = monthIndexOf(ts) - (retentionMonths - 1)
  const files = await statsFiles(dir)

  for (const { month, name } of files) {
    if (month < cutoff) {
      await rm(join(dir, name))
    }
  }
}

async function query(dir: string, filter: StatsQuery, now: () => number): Promise<StatsAggregate> {
  const dimension: StatsDimension = filter.by ?? 'model'
  const since = parseSince(filter.since, now())
  const runs = await readRuns(dir)
  const rows = new Map<string, StatsGroupRow>()
  let totalRuns = 0
  let totalIn = 0
  let totalOut = 0
  let totalTok = 0

  for (const run of runs) {
    if (since !== undefined && run.ts < since) {
      continue
    }

    if (filter.cwd !== undefined && run.cwd !== filter.cwd) {
      continue
    }

    totalRuns += 1
    totalIn += run.usage.inTok
    totalOut += run.usage.outTok
    totalTok += run.usage.totalTok

    if (dimension === 'dir') {
      accumulate(rows, run.cwd, run.usage.inTok, run.usage.outTok, run.usage.totalTok, true)
      continue
    }

    const seenKeys = new Set<string>()

    for (const usageRecord of run.usage.records) {
      const key = recordKey(usageRecord, dimension)

      accumulate(rows, key, usageRecord.inTok, usageRecord.outTok, usageRecord.totalTok, !seenKeys.has(key))
      seenKeys.add(key)
    }
  }

  return {
    dimension,
    rows: [...rows.values()].sort((left, right) => right.totalTok - left.totalTok),
    totalIn,
    totalOut,
    totalRuns,
    totalTok,
  }
}

async function readRuns(dir: string): Promise<RunStat[]> {
  const files = await statsFiles(dir)
  const runs: RunStat[] = []

  for (const { name } of files) {
    const content = await readFile(join(dir, name), 'utf8')

    for (const line of content.split('\n')) {
      if (line.trim() === '') {
        continue
      }

      const run = parseRunLine(line)

      if (run) {
        runs.push(run)
      }
    }
  }

  return runs
}

async function record(dir: string, input: RunStatInput, ts: number, retentionMonths: number): Promise<void> {
  const stat: RunStat = { ts, ...input }

  await mkdir(dir, { recursive: true })
  await appendFile(join(dir, statsFileName(ts)), `${JSON.stringify(stat)}\n`, 'utf8')
  await prune(dir, ts, retentionMonths)
}

function recordKey(record: StatsUsageRecord, dimension: StatsDimension): string {
  if (dimension === 'rule') {
    return record.ruleId
  }

  if (dimension === 'operation') {
    return record.operation ?? record.ruleId
  }

  return `${record.providerId}/${record.modelId}`
}

function statsFileName(ts: number): string {
  const date = new Date(ts)
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')

  return `stats-${year}-${month}.jsonl`
}

async function statsFiles(dir: string): Promise<Array<{ month: number, name: string }>> {
  let entries: string[]

  try {
    entries = await readdir(dir)
  }
  catch (error) {
    if (isEnoent(error)) {
      return []
    }

    throw error
  }

  return entries
    .map((name) => {
      const match = STATS_FILE_PATTERN.exec(name)

      return match ? { month: Number(match[1]) * 12 + (Number(match[2]) - 1), name } : undefined
    })
    .filter((entry): entry is { month: number, name: string } => entry !== undefined)
    .sort((left, right) => left.month - right.month)
}
