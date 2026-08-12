import process from 'node:process'

import { mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import { executeCli } from '../../cli'
import { startLspServer } from './server'
import { createTestClient, initializeParams } from './test-client'

/**
 * A project with one rule that counts its own executions.
 *
 * The rule calls no model, so a second execution costs nothing and is otherwise invisible. The
 * counter makes it visible: a cache replay still reports "checked 1", a second execution reports
 * "checked 2".
 *
 * The diagnostic is on line 3. A dropped `loc` falls back to line 0, so line 3 detects that too.
 */
async function writeFixtureProject(cwd: string): Promise<void> {
  await writeFile(join(cwd, 'demo.ts'), [
    '// two lines of header so the finding is not on line 1',
    '',
    'export function load() {}',
    '',
  ].join('\n'))

  const callKey = `__alintLspFixtureCalls_${cwd}`

  await writeFile(join(cwd, 'alint.config.ts'), `
const callKey = ${JSON.stringify(callKey)}
globalThis[callKey] = globalThis[callKey] ?? 0

export default [
  {
    files: ['**/*.ts'],
    plugins: {
      company: {
        rules: {
          cached: {
            languages: 'any',
            create: (ctx) => ({
              onTargetFunction: async (target) => {
                globalThis[callKey] += 1
                ctx.report({
                  filePath: target.file.path,
                  loc: target.loc,
                  message: 'checked ' + globalThis[callKey],
                })
              },
            }),
          },
        },
      },
    },
    rules: {
      'company/cached': 'warn',
    },
  },
]
`)
}

describe('alint lsp against a warm cache', () => {
  // Creating a directory symlink needs elevation or Developer Mode on Windows.
  it.skipIf(process.platform === 'win32')('replays what the CLI already paid for, through a symlinked workspace folder', async () => {
    // The only test that does not replace `runAlint`. A cwd or setup config mismatch gives zero
    // diagnostics and zero errors, so every test that uses a mock passes while the server is broken.
    const projectPath = await mkdtemp(join(tmpdir(), 'alint-lsp-integration-'))
    const configHome = await mkdtemp(join(tmpdir(), 'alint-lsp-integration-home-'))
    const env = { ...process.env, XDG_CONFIG_HOME: configHome }
    // `process.cwd()` gives the lint command a canonical path. The client gives the server the
    // path the user opened. The symlink makes the two differ, as they do for a symlinked project.
    const folderPath = `${projectPath}-link`

    await symlink(projectPath, folderPath, 'dir')

    const cwd = await realpath(folderPath)

    await writeFixtureProject(cwd)

    let stdoutText = ''
    const warmExitCode = await executeCli(['node', 'alint', '--format', 'json', 'demo.ts'], {
      cwd,
      env,
      stderr: { write: () => true },
      stdout: {
        write: (chunk) => {
          stdoutText += chunk
          return true
        },
      },
    })

    expect(warmExitCode).toBe(0)
    expect(JSON.parse(stdoutText).diagnostics[0].message).toBe('checked 1')
    await expect(readFile(join(cwd, '.alintcache'), 'utf8')).resolves.toContain('"entries"')

    const client = createTestClient(env)

    void startLspServer(client.io)
    client.send({
      id: 1,
      method: 'initialize',
      params: initializeParams(pathToFileURL(folderPath).toString()),
    })
    await client.receive()
    client.send({ method: 'initialized', params: {} })

    const published = await client.receive()

    expect(published.method).toBe('textDocument/publishDiagnostics')
    // The client path, not the resolved path the run used. An editor matches by exact URI.
    expect(published.params?.uri).toBe(pathToFileURL(join(folderPath, 'demo.ts')).toString())
    expect(published.params?.diagnostics).toHaveLength(1)
    // "checked 1", not "checked 2": the server replayed the cache entry and did not run the rule.
    expect(published.params?.diagnostics?.[0]?.message).toBe('checked 1')
    expect(published.params?.diagnostics?.[0]?.code).toBe('company/cached')
    expect(published.params?.diagnostics?.[0]?.source).toBe('alint')
    expect(published.params?.diagnostics?.[0]?.severity).toBe(2)
    // alint lines are 1-based and LSP lines are 0-based, so source line 3 becomes line 2.
    expect(published.params?.diagnostics?.[0]?.range.start.line).toBe(2)
  })
})
