import type { CliIo } from '../../types'

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { executeCli } from '../../cli'

interface TestIo extends CliIo {
  stderrText: string
  stdoutText: string
}

async function seedStats(): Promise<{ cwd: string, io: TestIo }> {
  const cwd = await mkdtemp(join(tmpdir(), 'alint-stats-cwd-'))
  const configHome = await mkdtemp(join(tmpdir(), 'alint-stats-home-'))
  const statsDir = join(configHome, 'alint', 'stats')

  await mkdir(statsDir, { recursive: true })

  const run = {
    cwd,
    ruleCounts: { cached: 0, cancelled: 0, completed: 1, failed: 0, planned: 1 },
    ruleDurations: [{ durationMs: 300, ruleId: 'r1' }],
    ts: Date.UTC(2026, 0, 10),
    usage: {
      inTok: 100,
      outTok: 20,
      records: [{ inTok: 100, modelId: 'gpt-4o', operation: 'judge', outTok: 20, providerId: 'openai', ruleId: 'r1', totalTok: 120 }],
      totalTok: 120,
    },
  }

  await writeFile(join(statsDir, 'stats-2026-01.jsonl'), `${JSON.stringify(run)}\n`)

  const io: TestIo = {
    cwd,
    env: { XDG_CONFIG_HOME: configHome },
    stderr: { write: (chunk: string) => void (io.stderrText += chunk) },
    stderrText: '',
    stdout: { write: (chunk: string) => void (io.stdoutText += chunk) },
    stdoutText: '',
  }

  return { cwd, io }
}

describe('alint stats command', () => {
  it('aggregates seeded runs by model as JSON', async () => {
    const { io } = await seedStats()

    const code = await executeCli(['node', 'alint', 'stats', '--json'], io)

    expect(code).toBe(0)
    const output = JSON.parse(io.stdoutText)
    expect(output.dimension).toBe('model')
    expect(output.totalRuns).toBe(1)
    expect(output.totalTok).toBe(120)
    expect(output.rows[0].key).toBe('openai/gpt-4o')
  })

  it('groups by operation', async () => {
    const { io } = await seedStats()

    const code = await executeCli(['node', 'alint', 'stats', '--by', 'operation', '--json'], io)

    expect(code).toBe(0)
    const output = JSON.parse(io.stdoutText)
    expect(output.dimension).toBe('operation')
    expect(output.rows[0].key).toBe('judge')
  })

  it('reports an invalid --by dimension', async () => {
    const { io } = await seedStats()

    const code = await executeCli(['node', 'alint', 'stats', '--by', 'bogus'], io)

    expect(code).toBe(2)
    expect(io.stderrText).toContain('Invalid --by "bogus"')
  })

  it('renders a bar chart with --chart', async () => {
    const { io } = await seedStats()

    const code = await executeCli(['node', 'alint', 'stats', '--by', 'rule', '--chart'], io)

    expect(code).toBe(0)
    expect(io.stdoutText).toContain('█')
    // The single seeded rule owns the whole run total.
    expect(io.stdoutText).toContain('100.0%')
  })

  it('lets --json win over --chart', async () => {
    const { io } = await seedStats()

    const code = await executeCli(['node', 'alint', 'stats', '--chart', '--json'], io)

    expect(code).toBe(0)
    expect(io.stdoutText).not.toContain('█')
    const output = JSON.parse(io.stdoutText)
    expect(output.dimension).toBe('model')
  })

  it('shows the recorded rule duration with --metric duration', async () => {
    const { io } = await seedStats()

    const code = await executeCli(['node', 'alint', 'stats', '--by', 'rule', '--metric', 'duration'], io)

    expect(code).toBe(0)
    // 300ms recorded for the seeded rule renders as 0.3s in the time column.
    expect(io.stdoutText).toContain('0.3s')
  })

  it('rejects --metric duration outside the rule dimension', async () => {
    const { io } = await seedStats()

    const code = await executeCli(['node', 'alint', 'stats', '--by', 'model', '--metric', 'duration'], io)

    expect(code).toBe(2)
    expect(io.stderrText).toContain('only available with --by rule')
  })

  it('reports an invalid --metric', async () => {
    const { io } = await seedStats()

    const code = await executeCli(['node', 'alint', 'stats', '--metric', 'bogus'], io)

    expect(code).toBe(2)
    expect(io.stderrText).toContain('Invalid --metric "bogus"')
  })
})
