import type { RunStatInput } from './types'

import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createJsonlStatsStore } from './jsonl'

function input(cwd: string, overrides: Partial<RunStatInput> = {}): RunStatInput {
  return {
    cwd,
    ruleCounts: { cached: 0, completed: 1, errored: 0, planned: 1 },
    usage: {
      inTok: 100,
      outTok: 20,
      records: [
        { inTok: 100, modelId: 'gpt-4o', operation: 'judge', outTok: 20, providerId: 'openai', ruleId: 'r1', totalTok: 120 },
      ],
      totalTok: 120,
    },
    ...overrides,
  }
}

function statLine(ts: number, cwd: string, overrides: Partial<RunStatInput> = {}): string {
  return `${JSON.stringify({ ts, ...input(cwd, overrides) })}\n`
}

function statsFileName(ts: number): string {
  const date = new Date(ts)
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')

  return `stats-${year}-${month}.jsonl`
}

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'alint-stats-'))
}

describe('createJsonlStatsStore', () => {
  it('appends one line per run into the month file', async () => {
    const dir = await tmp()
    const store = createJsonlStatsStore({ dir })

    await store.record(input('/p'))
    await store.record(input('/p'))

    const files = await readdir(dir)
    expect(files).toHaveLength(1)
    const content = await readFile(join(dir, files[0]!), 'utf8')
    expect(content.trim().split('\n')).toHaveLength(2)
  })

  it('reads runs from multiple monthly files', async () => {
    const dir = await tmp()
    const store = createJsonlStatsStore({ dir, retentionMonths: 0 })

    await writeFile(join(dir, 'stats-2026-01.jsonl'), statLine(Date.UTC(2026, 0, 10), '/jan'))
    await writeFile(join(dir, 'stats-2026-02.jsonl'), statLine(Date.UTC(2026, 1, 10), '/feb'))

    const agg = await store.query({ by: 'dir' })

    expect(agg.totalRuns).toBe(2)
    expect(agg.rows.map(row => row.key).sort()).toEqual(['/feb', '/jan'])
  })

  it('prunes files older than retentionMonths on write', async () => {
    const dir = await tmp()
    const currentTs = Date.now()
    const oldTs = new Date(currentTs)
    oldTs.setUTCFullYear(oldTs.getUTCFullYear() - 2)
    const oldFile = statsFileName(oldTs.getTime())
    await writeFile(join(dir, oldFile), statLine(oldTs.getTime(), '/p'))
    const store = createJsonlStatsStore({ dir, retentionMonths: 12 })

    await store.record(input('/p'))

    const files = await readdir(dir)
    expect(files).toHaveLength(1)
    expect(files).not.toContain(oldFile)
  })

  it('aggregates by model with run counts and totals', async () => {
    const dir = await tmp()
    const store = createJsonlStatsStore({ dir })

    await store.record(input('/p'))
    await store.record(input('/p'))
    const agg = await store.query({ by: 'model' })

    expect(agg.dimension).toBe('model')
    expect(agg.totalRuns).toBe(2)
    expect(agg.totalTok).toBe(240)
    expect(agg.rows).toHaveLength(1)
    expect(agg.rows[0].key).toBe('openai/gpt-4o')
    expect(agg.rows[0].runs).toBe(2)
    expect(agg.rows[0].totalTok).toBe(240)
  })

  it('falls back to rule id when grouping by operation on untagged records', async () => {
    const dir = await tmp()
    const store = createJsonlStatsStore({ dir })

    await store.record(input('/p', {
      usage: {
        inTok: 10,
        outTok: 2,
        records: [{ inTok: 10, modelId: 'm', outTok: 2, providerId: 'openai', ruleId: 'r9', totalTok: 12 }],
        totalTok: 12,
      },
    }))
    const agg = await store.query({ by: 'operation' })

    expect(agg.rows[0].key).toBe('r9')
  })

  it('filters by cwd and since', async () => {
    const dir = await tmp()
    const store = createJsonlStatsStore({ dir, retentionMonths: 0 })

    await writeFile(join(dir, 'stats-2026-01.jsonl'), [
      statLine(Date.UTC(2026, 0, 1), '/a'),
      statLine(Date.UTC(2026, 0, 20), '/b'),
    ].join(''))

    const byDir = await store.query({ by: 'dir', cwd: '/b' })
    expect(byDir.totalRuns).toBe(1)
    expect(byDir.rows[0].key).toBe('/b')

    const recent = await store.query({ since: '2026-01-15' })
    expect(recent.totalRuns).toBe(1)
  })

  it('returns an empty aggregate when the dir does not exist', async () => {
    const dir = join(await tmp(), 'nope')
    const store = createJsonlStatsStore({ dir })

    const agg = await store.query()

    expect(agg.totalRuns).toBe(0)
    expect(agg.rows).toEqual([])
  })
})
