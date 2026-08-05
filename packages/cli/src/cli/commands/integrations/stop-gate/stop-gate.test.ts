import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { x } from 'tinyexec'
import { describe, expect, it } from 'vitest'

import { executeCli } from '../../../cli'

describe('integrations stop-gate', () => {
  it('is inactive until the repository explicitly enables Stop Gate', async () => {
    const cwd = await createRepository(ruleConfig('warn', false))

    const result = await run(cwd, `inactive-${randomUUID()}`)

    expect(result.exitCode).toBe(0)
    expect(result.envelope.status).toBe('inactive')
  })

  it('returns warning diagnostics without retaining hook lifecycle state', async () => {
    const cwd = await createRepository(ruleConfig('warn'))
    const sessionId = `warnings-${randomUUID()}`

    const first = await run(cwd, sessionId)
    const second = await run(cwd, sessionId)

    expect(first.envelope.message).toBeUndefined()
    expect(first.exitCode).toBe(0)
    expect(first.envelope.status).toBe('warnings')
    expect(first.envelope.warningCount).toBe(1)
    expect(first.envelope.findingsHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(first.envelope.reportPath).toContain(sessionId)
    expect(second.exitCode).toBe(0)
    expect(second.envelope.status).toBe('warnings')
    expect(second.envelope.warningCount).toBe(1)
    expect(second.envelope.findingsHash).toBe(first.envelope.findingsHash)
  })

  it('returns error diagnostics', async () => {
    const cwd = await createRepository(ruleConfig('error'))
    const sessionId = `errors-${randomUUID()}`
    const result = await run(cwd, sessionId)

    expect(result.exitCode).toBe(0)
    expect(result.envelope.status).toBe('errors')
    expect(result.envelope.findingsHash).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('returns runtime configuration errors', async () => {
    const cwd = await createRepository([
      '[[config.group]]',
      'files = ["**/*.unknown"]',
      '',
      '[config.group.integrations.stopGate]',
      'target = "all"',
      '',
    ].join('\n'))
    const sessionId = `runtime-${randomUUID()}`

    const result = await run(cwd, sessionId)

    expect(result.exitCode).toBe(1)
    expect(result.envelope.status).toBe('runtime-error')
  })

  it('silently allows a repository without dirty files', async () => {
    const cwd = await createRepository([
      '[[config.group]]',
      'name = "stop gate"',
      '',
      '[config.group.integrations.stopGate]',
      'enabled = true',
      '',
      '[[config.group]]',
      'files = ["**/*.unknown"]',
      '',
    ].join('\n'), false)

    const result = await run(cwd, `clean-${randomUUID()}`)

    expect(result.exitCode).toBe(0)
    expect(result.envelope.status).toBe('no-dirty-files')
  })
})

interface Envelope {
  errorCount: number
  findingsHash?: string
  message?: string
  reportPath?: string
  status: string
  warningCount: number
}

async function createRepository(config: string, dirty = true): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'alint-stop-gate-command-'))
  await git(cwd, ['init'])
  await git(cwd, ['config', 'user.email', 'test@example.com'])
  await git(cwd, ['config', 'user.name', 'Test'])
  const configFile = config.startsWith('export default') ? 'alint.config.ts' : 'alint.config.toml'
  await writeFile(join(cwd, configFile), config, 'utf8')
  await writeFile(join(cwd, 'input.ts'), 'original\n', 'utf8')
  await git(cwd, ['add', '.'])
  await git(cwd, ['commit', '-m', 'initial'])

  if (dirty) {
    await writeFile(join(cwd, 'input.ts'), 'changed\n', 'utf8')
  }

  return cwd
}

async function git(cwd: string, args: string[]): Promise<void> {
  await x('git', args, {
    nodeOptions: { cwd },
    nodePath: false,
    throwOnError: true,
  })
}

function ruleConfig(severity: 'error' | 'warn', enabled = true): string {
  return `export default [{
    integrations: { stopGate: { enabled: ${enabled} } },
  }, {
    files: ['**/*.ts'],
    plugins: {
      test: {
        rules: {
          finding: {
            create: context => ({
              onTargetFile: target => context.report({
                filePath: target.file.path,
                message: 'Stop Gate test finding',
              }),
            }),
          },
        },
      },
    },
    rules: { 'test/finding': '${severity}' },
  }]\n`
}

async function run(cwd: string, sessionId: string): Promise<{
  envelope: Envelope
  exitCode: number
  stderr: string
}> {
  let stderr = ''
  let stdout = ''
  const exitCode = await executeCli([
    'node',
    'alint',
    'integrations',
    'stop-gate',
    '--session-id',
    sessionId,
  ], {
    cwd,
    env: { ...process.env, CI: 'true' },
    stderr: { write: chunk => stderr += chunk },
    stdout: { write: chunk => stdout += chunk },
  })

  return {
    envelope: JSON.parse(stdout) as Envelope,
    exitCode,
    stderr,
  }
}
