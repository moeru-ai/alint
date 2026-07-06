import type { RunStatInput } from './types'

import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createJsonlStatsStore } from './jsonl'

const JAN = Date.UTC(2026, 0, 10)
const FEB = Date.UTC(2026, 1, 10)

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

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'alint-stats-'))
}

describe('createJsonlStatsStore', () => {
  it('appends one line per run into the month file', async () => {
    const dir = await tmp()
    const store = createJsonlStatsStore({ clock: () => JAN, dir })

    await store.record(input('/p'))
    await store.record(input('/p'))

    expect(await readdir(dir)).toEqual(['stats-2026-01.jsonl'])
    const content = await readFile(join(dir, 'stats-2026-01.jsonl'), 'utf8')
    expect(content.trim().split('\n')).toHaveLength(2)
  })

  it('rotates into a new file when the month changes', async () => {
    const dir = await tmp()
    let clock = JAN
    const store = createJsonlStatsStore({ clock: () => clock, dir, retentionMonths: 0 })

    await store.record(input('/p'))
    clock = FEB
    await store.record(input('/p'))

    expect((await readdir(dir)).sort()).toEqual(['stats-2026-01.jsonl', 'stats-2026-02.jsonl'])
  })

  it('prunes files older than retentionMonths on write', async () => {
    const dir = await tmp()
    const oldRun = { cwd: '/p', ruleCounts: { cached: 0, completed: 0, errored: 0, planned: 0 }, ts: Date.UTC(2024, 0, 1), usage: { inTok: 0, outTok: 0, records: [], totalTok: 0 } }
    await writeFile(join(dir, 'stats-2024-01.jsonl'), `${JSON.stringify(oldRun)}\n`)
    const store = createJsonlStatsStore({ clock: () => JAN, dir, retentionMonths: 12 })

    await store.record(input('/p'))

    expect((await readdir(dir)).sort()).toEqual(['stats-2026-01.jsonl'])
  })

  it('aggregates by model with run counts and totals', async () => {
    const dir = await tmp()
    const store = createJsonlStatsStore({ clock: () => JAN, dir })

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
    const store = createJsonlStatsStore({ clock: () => JAN, dir })

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
    let clock = Date.UTC(2026, 0, 1)
    const store = createJsonlStatsStore({ clock: () => clock, dir, retentionMonths: 0 })

    await store.record(input('/a'))
    clock = Date.UTC(2026, 0, 20)
    await store.record(input('/b'))

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
