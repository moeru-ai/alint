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
    ruleCounts: { cached: 0, completed: 1, errored: 0, planned: 1 },
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

  it('loads static plugin config through the plugin lock', async () => {
    const { cwd, io } = await seedStats()
    const entry = join(cwd, '.alint', 'plugins', 'store', '@alint-js', 'plugin-python', '0.3.1', 'package', 'dist', 'index.mjs')
    await mkdir(join(entry, '..'), { recursive: true })
    await writeFile(entry, 'export default { rules: {} }\n')
    await writeFile(join(cwd, 'alint.config.toml'), `
[[config.group]]
files = ["**/*.py"]

[config.group.plugins]
python = "@alint-js/plugin-python@0.3.1"
`)
    await writeFile(join(cwd, '.alint', 'plugins', 'lock.json'), `${JSON.stringify({
      plugins: {
        python: {
          alias: 'python',
          apiVersion: '1',
          entry: '.alint/plugins/store/@alint-js/plugin-python/0.3.1/package/dist/index.mjs',
          integrity: 'sha512-test',
          name: '@alint-js/plugin-python',
          registry: 'https://registry.npmjs.org/',
          specifier: '@alint-js/plugin-python@0.3.1',
          tarball: 'https://registry.npmjs.org/plugin.tgz',
          version: '0.3.1',
        },
      },
      version: 1,
    }, null, 2)}\n`)

    const code = await executeCli(['node', 'alint', 'stats', '--json'], io)

    expect(code).toBe(0)
    expect(JSON.parse(io.stdoutText).totalRuns).toBe(1)
  })

  it('reports an invalid --by dimension', async () => {
    const { io } = await seedStats()

    const code = await executeCli(['node', 'alint', 'stats', '--by', 'bogus'], io)

    expect(code).toBe(2)
    expect(io.stderrText).toContain('Invalid --by "bogus"')
  })
})
