import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { x } from 'tinyexec'
import { describe, expect, it } from 'vitest'

const bundledHook = fileURLToPath(new URL('../scripts/stop-gate.mjs', import.meta.url))
const hookManifest = fileURLToPath(new URL('../hooks/hooks.json', import.meta.url))

type RepositoryActivation
  = | 'disabled'
    | 'enabled'
    | 'enabled-errors'
    | 'enabled-errors-exit-one'
    | 'enabled-silent-exit-one'
    | 'enabled-stderr-exit-one'
    | 'none'

describe('bundled Stop hook', () => {
  it('uses the supported command-string hook schema', async () => {
    const manifest = JSON.parse(await readFile(hookManifest, 'utf8')) as {
      hooks: { Stop: Array<{ hooks: Array<Record<string, unknown>> }> }
    }
    const handler = manifest.hooks.Stop[0]?.hooks[0]

    expect(handler?.command).toBe(`node "${'$'}{CLAUDE_PLUGIN_ROOT}/scripts/stop-gate.mjs"`)
    expect(handler).not.toHaveProperty('args')
  })

  it('contains no external runtime imports', async () => {
    const source = await readFile(bundledHook, 'utf8')
    const imports = [...source.matchAll(/^import .*? from ["'](.+?)["'];?$/gmu)]
      .map(match => match[1])
      .filter(specifier => !specifier?.startsWith('node:'))

    expect(imports).toEqual([])
  })

  it('is silent when the Git repository has no alint project config', async () => {
    const cwd = await createRepository('none')
    const pluginData = await mkdtemp(join(tmpdir(), 'alint-hook-data-'))

    const result = await runHook(cwd, pluginData, `inactive-${randomUUID()}`)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
  })

  it('is silent when the repository has not explicitly enabled Stop Gate', async () => {
    const cwd = await createRepository('disabled')
    const pluginData = await mkdtemp(join(tmpdir(), 'alint-hook-data-'))

    const result = await runHook(cwd, pluginData, `inactive-${randomUUID()}`)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
  })

  it('discovers the package manager from a non-executable lockfile', async () => {
    const cwd = await createRepository('enabled')
    const pluginData = await mkdtemp(join(tmpdir(), 'alint-hook-data-'))
    const binDirectory = await mkdtemp(join(tmpdir(), 'alint-hook-bin-'))
    const executable = join(binDirectory, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
    await rm(join(cwd, 'node_modules'), { recursive: true })
    await writeFile(join(cwd, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', { encoding: 'utf8', mode: 0o644 })
    await writeFile(executable, fakePackageManager(), 'utf8')
    await chmod(executable, 0o755)

    const result = await runHook(cwd, pluginData, `package-manager-${randomUUID()}`, false, {
      PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ''}`,
    })
    const decision = JSON.parse(result.stdout) as { decision?: string }

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(decision.decision).toBe('block')
  })

  it('blocks the first warning round and emits a system reminder on the next round', async () => {
    const cwd = await createRepository('enabled')
    const pluginData = await mkdtemp(join(tmpdir(), 'alint-hook-data-'))
    const sessionId = `warnings-${randomUUID()}`

    const first = await runHook(cwd, pluginData, sessionId)
    const second = await runHook(cwd, pluginData, sessionId, true)

    expect(first.exitCode).toBe(0)
    expect(first.stderr).toBe('')
    expect(first.stdout).not.toBe('')
    expect(second.exitCode).toBe(0)
    expect(second.stderr).toBe('')
    expect(second.stdout).not.toBe('')

    const firstDecision = JSON.parse(first.stdout) as { decision?: string, reason?: string }
    const secondDecision = JSON.parse(second.stdout) as { decision?: string, systemMessage?: string }

    expect(firstDecision.decision).toBe('block')
    expect(firstDecision.reason).toContain('alint-plugin: 0 error(s), 1 warning(s).')
    expect(secondDecision.decision).toBeUndefined()
    expect(secondDecision.systemMessage).toBe('alint-plugin: The same 0 error(s) and 1 warning(s) remain unchanged from the previous automatic lint. Stop Gate is allowing this turn to finish. The report remains at "/tmp/alint-stop-gate/report.json".')
  })

  it('allows errors when the second consecutive lint returns identical findings', async () => {
    const cwd = await createRepository('enabled-errors')
    const pluginData = await mkdtemp(join(tmpdir(), 'alint-hook-data-'))
    const sessionId = `errors-${randomUUID()}`

    const first = await runHook(cwd, pluginData, sessionId)
    const second = await runHook(cwd, pluginData, sessionId, true)
    const firstDecision = JSON.parse(first.stdout) as { decision?: string }
    const secondDecision = JSON.parse(second.stdout) as { decision?: string, systemMessage?: string }

    expect(first.exitCode).toBe(0)
    expect(firstDecision.decision).toBe('block')
    expect(second.exitCode).toBe(0)
    expect(secondDecision.decision).toBeUndefined()
    expect(secondDecision.systemMessage).toContain('The same 1 error(s) and 0 warning(s) remain unchanged')
  })

  it('treats an alint exit 1 with a findings envelope as a runtime failure', async () => {
    const cwd = await createRepository('enabled-errors-exit-one')
    const pluginData = await mkdtemp(join(tmpdir(), 'alint-hook-data-'))
    const result = await runHook(cwd, pluginData, `abnormal-${randomUUID()}`)
    const decision = JSON.parse(result.stdout) as { decision?: string, reason?: string }

    expect(result.exitCode).toBe(0)
    expect(decision.decision).toBe('block')
    expect(decision.reason).toContain('alint Stop Gate returned status "errors" with unexpected exit code 1')
  })

  it('reports bounded stderr when alint exits 1 without an envelope', async () => {
    const cwd = await createRepository('enabled-stderr-exit-one')
    const pluginData = await mkdtemp(join(tmpdir(), 'alint-hook-data-'))
    const result = await runHook(cwd, pluginData, `stderr-${randomUUID()}`)
    const decision = JSON.parse(result.stdout) as { decision?: string, reason?: string }
    const error = decision.reason?.split('following error: ', 2)[1] ?? ''
    const stderr = error.split('exit code 1: ', 2)[1] ?? ''

    expect(result.exitCode).toBe(0)
    expect(decision.decision).toBe('block')
    expect(error).toContain('stderr-head-')
    expect(error).toContain('-stderr-tail')
    expect(error).toContain('... stderr truncated ...')
    expect(error).not.toContain('stderr-middle')
    expect(stderr).not.toContain('\uFFFD')
    expect(Buffer.byteLength(stderr)).toBeLessThanOrEqual(4 * 1024)
  })

  it('reports a fixed error when alint exits 1 without output', async () => {
    const cwd = await createRepository('enabled-silent-exit-one')
    const pluginData = await mkdtemp(join(tmpdir(), 'alint-hook-data-'))
    const result = await runHook(cwd, pluginData, `silent-${randomUUID()}`)
    const decision = JSON.parse(result.stdout) as { decision?: string, reason?: string }

    expect(result.exitCode).toBe(0)
    expect(decision.decision).toBe('block')
    expect(decision.reason).toContain('alint Stop Gate exited abnormally with exit code 1 and produced no stderr output.')
  })
})

async function createRepository(
  activation: RepositoryActivation,
): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'alint-hook-repo-'))
  await x('git', ['init'], { nodeOptions: { cwd }, nodePath: false, throwOnError: true })

  if (activation === 'none') {
    return cwd
  }

  await writeFile(join(cwd, 'alint.config.toml'), '[[config.group]]\nname = "rules"\n', 'utf8')
  const binDirectory = join(cwd, 'node_modules', '.bin')
  const executable = join(binDirectory, process.platform === 'win32' ? 'alint.cmd' : 'alint')
  await mkdir(binDirectory, { recursive: true })
  await writeFile(executable, fakeAlint(activation), 'utf8')
  await chmod(executable, 0o755)
  return cwd
}

function fakeAlint(activation: Exclude<RepositoryActivation, 'none'>): string {
  const enabled = activation !== 'disabled'
  const errors = activation === 'enabled-errors' || activation === 'enabled-errors-exit-one'
  const abnormalExit = activation === 'enabled-errors-exit-one'
  const stderrExit = activation === 'enabled-stderr-exit-one'
  const silentExit = activation === 'enabled-silent-exit-one'

  return `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args.join(' ') === 'config integrations stop-gate show') {
  process.stdout.write('config: alint.config.toml\\nenabled: ${enabled}\\ntarget: dirty-files (default)\\ntimeoutMs: 900000 (default)\\n')
} else if (args[0] === 'integrations' && args[1] === 'stop-gate') {
  if (${stderrExit}) {
    process.stderr.write('stderr-head-' + '界'.repeat(1500) + 'stderr-middle' + '文'.repeat(1500) + '-stderr-tail')
    process.exitCode = 1
  } else if (${silentExit}) {
    process.exitCode = 1
  } else {
    process.stdout.write(JSON.stringify({
      errorCount: ${errors ? 1 : 0},
      findingsHash: 'a'.repeat(64),
      reportPath: '/tmp/alint-stop-gate/report.json',
      schemaVersion: 2,
      status: '${errors ? 'errors' : 'warnings'}',
      warningCount: ${errors ? 0 : 1},
    }) + '\\n')
    process.exitCode = ${abnormalExit ? 1 : 0}
  }
} else {
  process.exitCode = 2
}
`
}

function fakePackageManager(): string {
  return `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args.join(' ') === 'exec alint config integrations stop-gate show') {
  process.stdout.write('config: alint.config.toml\\nenabled: true\\ntarget: dirty-files (default)\\ntimeoutMs: 900000 (default)\\n')
} else if (args[0] === 'exec' && args[1] === 'alint' && args[2] === 'integrations' && args[3] === 'stop-gate') {
  process.stdout.write(JSON.stringify({
    errorCount: 0,
    findingsHash: 'a'.repeat(64),
    reportPath: '/tmp/alint-stop-gate/report.json',
    schemaVersion: 2,
    status: 'warnings',
    warningCount: 1,
  }) + '\\n')
} else {
  process.exitCode = 2
}
`
}

async function runHook(
  cwd: string,
  pluginData: string,
  sessionId: string,
  stopHookActive = false,
  env: NodeJS.ProcessEnv = {},
) {
  return x(process.execPath, [bundledHook], {
    nodeOptions: {
      env: { ...process.env, ...env, CLAUDE_PLUGIN_DATA: pluginData },
    },
    stdin: JSON.stringify({
      cwd,
      hook_event_name: 'Stop',
      session_id: sessionId,
      stop_hook_active: stopHookActive,
      turn_id: randomUUID(),
    }),
    throwOnError: false,
  })
}
