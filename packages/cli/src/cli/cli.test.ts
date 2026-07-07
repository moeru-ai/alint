import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getGlobalSetupConfigPath, getProjectSetupConfigPath, writeSetupConfig } from '@alint-js/config'
import { describe, expect, it } from 'vitest'

import { executeCli } from './cli'
import { formatProbeModelsFailure, isBackInput, withBackOption } from './commands/setup/interactive'
import { createProviderId } from './provider-registry'

interface TestIo {
  cwd: string
  env?: NodeJS.ProcessEnv
  stderr: { columns?: number, isTTY?: boolean, write: (chunk: string) => void }
  stderrText: string
  stdout: { write: (chunk: string) => void }
  stdoutText: string
}

// Remove CI signals so the stats writer still works in the CI environment.
function clearCiEnv(env: NodeJS.ProcessEnv | undefined): void {
  if (!env) {
    return
  }

  for (const key of ['BUILDKITE', 'CI', 'CIRCLECI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'TF_BUILD']) {
    delete env[key]
  }
}

async function createTestIo(): Promise<TestIo> {
  const cwd = await mkdtemp(join(tmpdir(), 'alint-cli-'))
  const configHome = await mkdtemp(join(tmpdir(), 'alint-config-home-'))
  const io: TestIo = {
    cwd,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: configHome,
    },
    stderr: {
      write: (chunk: string) => {
        io.stderrText += chunk
      },
    },
    stderrText: '',
    stdout: {
      write: (chunk: string) => {
        io.stdoutText += chunk
      },
    },
    stdoutText: '',
  }

  return io
}

function statsDirOf(io: { env?: NodeJS.ProcessEnv }): string {
  return join(io.env?.XDG_CONFIG_HOME ?? '', 'alint', 'stats')
}

async function withModelsServer(
  handler: (request: { headers: NodeJS.Dict<string | string[] | undefined>, url?: string }) => { body: unknown, status?: number },
): Promise<{ close: () => Promise<void>, endpoint: string }> {
  const server = createServer((request, response) => {
    const result = handler({ headers: request.headers, url: request.url })
    response.statusCode = result.status ?? 200
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(result.body))
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })

  const address = server.address()

  if (address === null || typeof address === 'string') {
    throw new Error('Expected TCP test server address.')
  }

  return {
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }

        resolve()
      })
    }),
    endpoint: `http://127.0.0.1:${address.port}/v1/`,
  }
}

async function writeCacheFixture(cwd: string, runnerConfig = ''): Promise<void> {
  await writeFile(join(cwd, 'demo.ts'), 'export function load() {}\n')
  const callKey = `__alintCacheFixtureCalls_${cwd}`
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
            create: (ctx) => ({
              onTarget: async (target) => {
                if (target.kind !== 'function') return
                globalThis[callKey] += 1
                ctx.report({
                  filePath: target.file.path,
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
    ${runnerConfig}
  },
]
`)
}

async function writeOutputLanguageFixture(cwd: string): Promise<void> {
  await writeFile(join(cwd, 'demo.ts'), 'export function load() {}\n')
  await writeFile(join(cwd, 'alint.config.ts'), `
export default [
  {
    plugins: {
      review: {
        rules: {
          language: {
            create: ctx => ({
              onTarget: target => {
                if (target.kind !== 'file') return
                ctx.report({
                  filePath: target.file.path,
                  message: 'answer in ' + ctx.outputLanguage,
                })
              },
            }),
          },
        },
      },
    },
    rules: {
      'review/language': 'warn',
    },
  },
]
`)
}

async function writeProgressFixture(cwd: string): Promise<void> {
  await writeFile(join(cwd, 'demo.ts'), [
    'export function load() {',
    '  return 1',
    '}',
    '',
  ].join('\n'))

  await writeFile(join(cwd, 'alint.config.ts'), `
export default [
  {
    files: ['**/*.ts'],
    plugins: {
      company: {
        rules: {
          'prefer-load': {
            create: (ctx) => ({
              onTarget: async (target) => {
                if (target.kind !== 'function') return
                ctx.report({
                  filePath: target.file.path,
                  message: 'Problem found',
                  loc: target.loc,
                })
              },
            }),
          },
        },
      },
    },
    rules: {
      'company/prefer-load': 'warn',
    },
  },
]
`)
}

// A run fixture whose rule records inference usage directly via ctx.metering, so a full lint
// run produces usage records (with an `operation` tag) without any model/provider HTTP.
async function writeStatsFixture(cwd: string): Promise<void> {
  await writeFile(join(cwd, 'demo.ts'), 'export function load() {}\n')
  await writeFile(join(cwd, 'alint.config.ts'), `
export default [
  {
    files: ['**/*.ts'],
    plugins: {
      company: {
        rules: {
          judge: {
            create: ctx => ({
              onTarget: (target) => {
                if (target.kind !== 'function') return
                ctx.metering.recordUsage({
                  filePath: target.file.path,
                  inputTokens: 100,
                  metadata: { operation: 'judge' },
                  modelId: 'gpt-4o',
                  outputTokens: 20,
                  providerId: 'openai',
                  totalTokens: 120,
                })
                ctx.report({ filePath: target.file.path, message: 'checked' })
              },
            }),
          },
        },
      },
    },
    rules: {
      'company/judge': 'warn',
    },
  },
]
`)
}

describe('createProviderId', () => {
  it('creates endpoint-based provider ids and avoids collisions', () => {
    expect(createProviderId('http://localhost:11434/v1', new Set())).toBe('localhost')
    expect(createProviderId('https://openrouter.ai/api/v1', new Set(['openrouter-ai']))).toBe('openrouter-ai-2')
    expect(createProviderId('not a url', new Set())).toBe('provider')
  })
})

describe('interactive setup navigation', () => {
  it('adds an explicit back option and recognizes text back input', () => {
    expect(withBackOption([{ label: 'Ollama', value: 'ollama' }])).toEqual([
      { label: 'Ollama', value: 'ollama' },
      { label: 'Back', value: '__alint_back__' },
    ])
    expect(isBackInput('..')).toBe(true)
    expect(isBackInput(' .. ')).toBe(true)
    expect(isBackInput('qwen:8b')).toBe(false)
  })

  it('explains likely Ollama HTTPS probe failures', () => {
    expect(formatProbeModelsFailure('https://localhost:11434/v1', new Error('fetch failed'))).toBe(
      'Could not probe models: fetch failed. Ollama usually uses http://localhost:11434/v1.',
    )
  })
})

describe('executeCli', () => {
  async function writeRunOutputFixture(cwd: string, fileName = 'alint-output.json'): Promise<string> {
    const outputPath = join(cwd, fileName)

    await writeFile(outputPath, JSON.stringify({
      diagnostics: [
        {
          filePath: '/repo/src/demo.ts',
          loc: { start: { column: 3, line: 12 } },
          message: 'Problem found',
          ruleId: 'company/problem',
          severity: 'warn',
        },
      ],
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        records: [],
        totalTokens: 15,
      },
    }, null, 2))

    return outputPath
  }

  it('renders saved output with the stylish reporter by default', async () => {
    const io = await createTestIo()
    const outputPath = await writeRunOutputFixture(io.cwd)

    const exitCode = await executeCli(['node', 'alint', 'output', 'inspect', outputPath], io)

    expect(exitCode).toBe(1)
    expect(io.stdoutText).toContain('/repo/src/demo.ts')
    expect(io.stdoutText).toContain('12:3')
    expect(io.stdoutText).toContain('warning')
    expect(io.stdoutText).toContain('Problem found')
    expect(io.stdoutText).toContain('company/problem')
    expect(io.stdoutText).toContain('1 warn / 0 error | 15 tokens')
    expect(io.stderrText).toBe('')
  })

  it('records a stats line after a lint run', async () => {
    const io = await createTestIo()
    clearCiEnv(io.env)
    await writeStatsFixture(io.cwd)

    const exitCode = await executeCli(['node', 'alint', 'demo.ts'], io)

    expect(exitCode).toBe(1)
    const files = await readdir(statsDirOf(io))
    expect(files).toHaveLength(1)
    const lines = (await readFile(join(statsDirOf(io), files[0]), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(1)
    const record = JSON.parse(lines[0])
    expect(record.cwd).toBe(io.cwd)
    expect(record.ruleCounts.completed).toBeGreaterThanOrEqual(1)
    expect(record.usage.totalTok).toBe(120)
    expect(record.usage.records[0].operation).toBe('judge')
    expect(record.usage.records[0].modelId).toBe('gpt-4o')
  })

  it('does not record stats with --no-stats', async () => {
    const io = await createTestIo()
    clearCiEnv(io.env)
    await writeStatsFixture(io.cwd)

    await executeCli(['node', 'alint', '--no-stats', 'demo.ts'], io)

    // The stats dir is only created on write, so its absence proves nothing was recorded.
    await expect(readdir(statsDirOf(io))).rejects.toThrow()
  })

  it('does not record stats in CI', async () => {
    const io = await createTestIo()
    clearCiEnv(io.env)

    if (io.env) {
      io.env.CI = 'true'
    }

    await writeStatsFixture(io.cwd)

    await executeCli(['node', 'alint', 'demo.ts'], io)

    await expect(readdir(statsDirOf(io))).rejects.toThrow()
  })

  it('reprints saved output with the json reporter', async () => {
    const io = await createTestIo()
    const outputPath = await writeRunOutputFixture(io.cwd)

    const exitCode = await executeCli([
      'node',
      'alint',
      'output',
      'inspect',
      outputPath,
      '--format',
      'json',
    ], io)

    expect(exitCode).toBe(1)
    expect(JSON.parse(io.stdoutText)).toEqual({
      diagnostics: [
        {
          filePath: '/repo/src/demo.ts',
          loc: { start: { column: 3, line: 12 } },
          message: 'Problem found',
          ruleId: 'company/problem',
          severity: 'warn',
        },
      ],
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        records: [],
        totalTokens: 15,
      },
    })
    expect(io.stderrText).toBe('')
  })

  it('returns 2 for unknown output inspect formats', async () => {
    const io = await createTestIo()
    const outputPath = await writeRunOutputFixture(io.cwd)

    const exitCode = await executeCli([
      'node',
      'alint',
      'output',
      'inspect',
      outputPath,
      '--format',
      'compact',
    ], io)

    expect(exitCode).toBe(2)
    expect(io.stdoutText).toBe('')
    expect(io.stderrText).toContain('Unknown reporter "compact".')
  })

  it('returns 2 for invalid output json', async () => {
    const io = await createTestIo()
    const outputPath = join(io.cwd, 'broken.json')
    await writeFile(outputPath, '{')

    const exitCode = await executeCli(['node', 'alint', 'output', 'inspect', outputPath], io)

    expect(exitCode).toBe(2)
    expect(io.stdoutText).toBe('')
    expect(io.stderrText).toContain('Could not parse output file')
  })

  it('returns 2 for structurally invalid alint output', async () => {
    const io = await createTestIo()
    const outputPath = join(io.cwd, 'invalid-output.json')
    await writeFile(outputPath, JSON.stringify({ diagnostics: {} }))

    const exitCode = await executeCli(['node', 'alint', 'output', 'inspect', outputPath], io)

    expect(exitCode).toBe(2)
    expect(io.stdoutText).toBe('')
    expect(io.stderrText).toContain('Invalid alint output')
  })

  it('returns 2 when the output file cannot be read', async () => {
    const io = await createTestIo()
    const outputPath = join(io.cwd, 'missing.json')

    const exitCode = await executeCli(['node', 'alint', 'output', 'inspect', outputPath], io)

    expect(exitCode).toBe(2)
    expect(io.stdoutText).toBe('')
    expect(io.stderrText).toContain('Could not read output file')
  })

  it('prints a generic unknown command message for command groups', async () => {
    const io = await createTestIo()

    const exitCode = await executeCli(['node', 'alint', 'output'], io)

    expect(exitCode).toBe(2)
    expect(io.stdoutText).toBe('')
    expect(io.stderrText).toBe('unknown command: output\n')
  })

  it('prints output inspect in output command help', async () => {
    const io = await createTestIo()

    const exitCode = await executeCli(['node', 'alint', 'output', '--help'], io)

    expect(exitCode).toBe(0)
    expect(io.stdoutText).toContain('Inspect saved alint run outputs without rerunning rules or model calls.')
    expect(io.stdoutText).toContain('Use this when you already have JSON from `alint --format json`')
    expect(io.stdoutText).toContain('Usage:')
    expect(io.stdoutText).toContain('$ alint output')
    expect(io.stdoutText).toContain('Commands:')
    expect(io.stdoutText).toContain('output inspect <file>')
    expect(io.stdoutText).toContain('Inspect saved alint JSON output')
    expect(io.stdoutText).not.toContain('--cache-location')
    expect(io.stderrText).toBe('')
  })

  it('prints output inspect usage and options in output inspect help', async () => {
    const io = await createTestIo()

    const exitCode = await executeCli(['node', 'alint', 'output', 'inspect', '--help'], io)

    expect(exitCode).toBe(0)
    expect(io.stdoutText).toContain('Read a saved alint JSON run result and render it with a reporter.')
    expect(io.stdoutText).toContain('Defaults to the human-friendly stylish reporter')
    expect(io.stdoutText).toContain('Examples:')
    expect(io.stdoutText).toContain('# Pretty-print saved JSON output')
    expect(io.stdoutText).toContain('alint output inspect alint-output.json')
    expect(io.stdoutText).toContain('# Validate and reprint normalized JSON')
    expect(io.stdoutText).toContain('alint output inspect alint-output.json --format json')
    expect(io.stdoutText).toContain('Usage:')
    expect(io.stdoutText).toContain('$ alint output inspect <file>')
    expect(io.stdoutText).toContain('Options:')
    expect(io.stdoutText).toContain('-f, --format <format>')
    expect(io.stdoutText).not.toContain('--cache-location')
    expect(io.stderrText).toBe('')
  })

  it('prints only direct config subcommands in config command help', async () => {
    const io = await createTestIo()

    const exitCode = await executeCli(['node', 'alint', 'config', '--help'], io)

    expect(exitCode).toBe(0)
    expect(io.stdoutText).toContain('Inspect and update alint setup/configuration state.')
    expect(io.stdoutText).toContain('Examples:')
    expect(io.stdoutText).toContain('alint config inspect src/index.ts')
    expect(io.stdoutText).toContain('alint config providers list')
    expect(io.stdoutText).toContain('alint config models list')
    expect(io.stdoutText).toContain('alint config models probe --endpoint https://openrouter.ai/api/v1')
    expect(io.stdoutText).toContain('Commands:')
    expect(io.stdoutText).toContain('config inspect <file>')
    expect(io.stdoutText).toContain('config models')
    expect(io.stdoutText).toContain('config providers')
    expect(io.stderrText).toBe('')
  })

  it('prints description for config inspect help', async () => {
    const io = await createTestIo()

    const exitCode = await executeCli(['node', 'alint', 'config', 'inspect', '--help'], io)

    expect(exitCode).toBe(0)
    expect(io.stdoutText).toContain('Inspect resolved config for a file')
    expect(io.stdoutText).toContain('Usage:')
    expect(io.stdoutText).toContain('$ alint config inspect <file>')
    expect(io.stderrText).toBe('')
  })

  it('prints contextual help when global options come before the command', async () => {
    const io = await createTestIo()

    const exitCode = await executeCli([
      'node',
      'alint',
      '--config',
      'alint.config.ts',
      'config',
      'inspect',
      '--help',
    ], io)

    expect(exitCode).toBe(0)
    expect(io.stdoutText).toContain('Inspect resolved config for a file')
    expect(io.stdoutText).toContain('Usage:')
    expect(io.stdoutText).toContain('$ alint config inspect <file>')
    expect(io.stdoutText).not.toContain('$ alint [...files]')
    expect(io.stderrText).toBe('')
  })

  it('prints only direct nested config subcommands in config models help', async () => {
    const io = await createTestIo()

    const exitCode = await executeCli(['node', 'alint', 'config', 'models', '--help'], io)

    expect(exitCode).toBe(0)
    expect(io.stdoutText).toContain('Inspect, list, and probe model entries from alint setup configuration.')
    expect(io.stdoutText).toContain('Commands:')
    expect(io.stdoutText).toContain('config models probe')
    expect(io.stdoutText).toContain('config models list')
    expect(io.stdoutText).toContain('config models show <model>')
    expect(io.stdoutText).not.toContain('config providers')
    expect(io.stdoutText).not.toContain('--provider-header')
    expect(io.stderrText).toBe('')
  })

  it('prints nested command usage and options in config models probe help', async () => {
    const io = await createTestIo()

    const exitCode = await executeCli(['node', 'alint', 'config', 'models', 'probe', '--help'], io)

    expect(exitCode).toBe(0)
    expect(io.stdoutText).toContain('Probe an OpenAI-compatible models endpoint before saving it in setup config.')
    expect(io.stdoutText).toContain('Examples:')
    expect(io.stdoutText).toContain('alint config models probe --endpoint https://openrouter.ai/api/v1')
    expect(io.stdoutText).toContain('Usage:')
    expect(io.stdoutText).toContain('$ alint config models probe')
    expect(io.stdoutText).toContain('Options:')
    expect(io.stdoutText).toContain('--endpoint <url>')
    expect(io.stdoutText).toContain('--provider-header <Key=Value>')
    expect(io.stdoutText).not.toContain('--cache-location')
    expect(io.stderrText).toBe('')
  })

  it('writes local setup config and returns 0 for non-interactive setup', async () => {
    const io = await createTestIo()

    const exitCode = await executeCli([
      'node',
      'alint',
      'setup',
      '-N',
      '--local',
      '--provider-id',
      'ollama',
      '--provider-endpoint',
      'http://localhost:11434/v1',
      '--provider-model',
      'qwen:8b',
    ], io)

    expect(exitCode).toBe(0)

    const toml = await readFile(getProjectSetupConfigPath(io.cwd), 'utf8')
    expect(toml).toContain('id = "ollama"')
    expect(toml).toContain('endpoint = "http://localhost:11434/v1"')
    expect(toml).toContain('id = "qwen:8b"')
  })

  it('treats --no-interactive as equivalent to -N', async () => {
    const io = await createTestIo()

    const exitCode = await executeCli([
      'node',
      'alint',
      'setup',
      '--no-interactive',
      '--local',
      '--provider-id',
      'ollama',
      '--provider-endpoint',
      'http://localhost:11434/v1',
      '--provider-model',
      'qwen:8b',
    ], io)

    expect(exitCode).toBe(0)
    expect(await readFile(getProjectSetupConfigPath(io.cwd), 'utf8')).toContain('id = "qwen:8b"')
  })

  it('writes provider id from --provider-id during non-interactive setup', async () => {
    const io = await createTestIo()

    const exitCode = await executeCli([
      'node',
      'alint',
      'setup',
      '-N',
      '--local',
      '--provider-id',
      'ollama',
      '--provider-endpoint',
      'http://localhost:11434/v1',
      '--provider-model',
      'qwen:8b',
    ], io)

    expect(exitCode).toBe(0)

    const toml = await readFile(getProjectSetupConfigPath(io.cwd), 'utf8')
    expect(toml).toContain('id = "ollama"')
    expect(toml).toContain('endpoint = "http://localhost:11434/v1"')
    expect(toml).toContain('id = "qwen:8b"')
  })

  it('keeps repeated setup providers separate when provider ids differ', async () => {
    const io = await createTestIo()

    const firstExitCode = await executeCli([
      'node',
      'alint',
      'setup',
      '-N',
      '--local',
      '--provider-id',
      'first',
      '--provider-endpoint',
      'http://localhost:11434/v1',
      '--provider-model',
      'first-model',
      '--provider-header',
      'Authorization=Bearer first',
    ], io)

    expect(firstExitCode).toBe(0)

    const secondExitCode = await executeCli([
      'node',
      'alint',
      'setup',
      '-N',
      '--local',
      '--provider-id',
      'second',
      '--provider-endpoint',
      'http://localhost:11434/v1',
      '--provider-model',
      'second-model',
      '--provider-header',
      'Authorization=Bearer second',
    ], io)

    expect(secondExitCode).toBe(0)

    const toml = await readFile(getProjectSetupConfigPath(io.cwd), 'utf8')
    expect(toml).toContain('id = "first"')
    expect(toml).toContain('id = "second"')
    expect(toml).toContain('id = "first-model"')
    expect(toml).toContain('id = "second-model"')
    expect(toml).toContain('Authorization = "Bearer first"')
    expect(toml).toContain('Authorization = "Bearer second"')
  })

  it('writes global setup config under XDG_CONFIG_HOME with repeated models and headers', async () => {
    const io = await createTestIo()
    const configHome = await mkdtemp(join(tmpdir(), 'alint-config-home-'))
    io.env = {
      ...process.env,
      XDG_CONFIG_HOME: configHome,
    }

    const exitCode = await executeCli([
      'node',
      'alint',
      'setup',
      '-N',
      '--provider-id',
      'ollama',
      '--provider-endpoint',
      'http://localhost:11434/v1',
      '--provider-model',
      'qwen:8b',
      '--provider-model',
      'qwen:32b',
      '--provider-header',
      'Authorization=Bearer token',
      '--provider-header',
      'X-Test=true',
    ], io)

    expect(exitCode).toBe(0)

    const toml = await readFile(join(configHome, 'alint/config.toml'), 'utf8')
    expect(toml).toContain('id = "qwen:8b"')
    expect(toml).toContain('id = "qwen:32b"')
    expect(toml).toContain('Authorization = "Bearer token"')
    expect(toml).toContain('X-Test = "true"')
  })

  it('prints discovered models from config models probe', async () => {
    const io = await createTestIo()
    const server = await withModelsServer(({ headers, url }) => {
      expect(url).toBe('/v1/models')
      expect(headers.authorization).toBe('Bearer probe')

      return {
        body: {
          data: [
            { id: 'qwen:8b' },
            { id: 'qwen:32b' },
            { id: 123 },
          ],
        },
      }
    })

    try {
      const exitCode = await executeCli([
        'node',
        'alint',
        'config',
        'models',
        'probe',
        '--endpoint',
        server.endpoint,
        '--provider-header',
        'Authorization=Bearer probe',
      ], io)

      expect(exitCode).toBe(0)
      expect(io.stdoutText).toBe('qwen:8b\nqwen:32b\n')
      expect(io.stderrText).toBe('')
    }
    finally {
      await server.close()
    }
  })

  it('returns 2 when config models probe cannot read OpenAI-compatible models', async () => {
    const io = await createTestIo()
    const server = await withModelsServer(() => ({ body: { data: [] }, status: 500 }))

    try {
      const exitCode = await executeCli([
        'node',
        'alint',
        'config',
        'models',
        'probe',
        '--endpoint',
        server.endpoint,
      ], io)

      expect(exitCode).toBe(2)
      expect(io.stderrText).toContain('failed to probe models:')
      expect(io.stdoutText).toBe('')
    }
    finally {
      await server.close()
    }
  })

  it('returns 2 when config models probe receives a malformed response', async () => {
    const io = await createTestIo()
    const server = await withModelsServer(() => ({ body: {} }))

    try {
      const exitCode = await executeCli([
        'node',
        'alint',
        'config',
        'models',
        'probe',
        '--endpoint',
        server.endpoint,
      ], io)

      expect(exitCode).toBe(2)
      expect(io.stderrText).toContain('failed to probe models:')
      expect(io.stdoutText).toBe('')
    }
    finally {
      await server.close()
    }
  })

  it('lists flattened configured models', async () => {
    const io = await createTestIo()

    await writeSetupConfig(getProjectSetupConfigPath(io.cwd), {
      providers: [
        {
          endpoint: 'http://localhost:11434/v1',
          id: 'ollama',
          models: [
            { id: 'local:qwen-8b', name: 'qwen:8b' },
            { id: 'local:qwen-32b' },
          ],
          type: 'openai-compatible',
        },
      ],
      version: 1,
    })

    const exitCode = await executeCli([
      'node',
      'alint',
      'config',
      'models',
      'ls',
    ], io)

    expect(exitCode).toBe(0)
    expect(io.stdoutText).toBe([
      'id              provider  name            ',
      'local:qwen-8b   ollama    qwen:8b         ',
      'local:qwen-32b  ollama    local:qwen-32b  ',
      '',
    ].join('\n'))
  })

  it('shows one configured model by alias without printing header values', async () => {
    const io = await createTestIo()

    await writeSetupConfig(getProjectSetupConfigPath(io.cwd), {
      providers: [
        {
          endpoint: 'http://localhost:11434/v1',
          headers: { Authorization: 'Bearer secret' },
          id: 'ollama',
          models: [
            {
              aliases: ['default'],
              capabilities: ['code-review'],
              contextWindow: 32768,
              defaultParams: { temperature: 0.1 },
              id: 'local:qwen-8b',
              name: 'qwen:8b',
              size: 'small',
            },
          ],
          type: 'openai-compatible',
        },
      ],
      version: 1,
    })

    const exitCode = await executeCli([
      'node',
      'alint',
      'config',
      'models',
      'show',
      'default',
    ], io)

    expect(exitCode).toBe(0)
    expect(io.stdoutText).toContain('id: local:qwen-8b\n')
    expect(io.stdoutText).toContain('name: qwen:8b\n')
    expect(io.stdoutText).toContain('provider: ollama\n')
    expect(io.stdoutText).toContain('aliases: default\n')
    expect(io.stdoutText).toContain('capabilities: code-review\n')
    expect(io.stdoutText).toContain('contextWindow: 32768\n')
    expect(io.stdoutText).toContain('defaultParams: {"temperature":0.1}\n')
    expect(io.stdoutText).not.toContain('secret')
  })

  it('returns 2 when model is unknown', async () => {
    const io = await createTestIo()

    const exitCode = await executeCli([
      'node',
      'alint',
      'config',
      'models',
      'show',
      'missing',
    ], io)

    expect(exitCode).toBe(2)
    expect(io.stderrText).toBe('unknown model "missing".\n')
  })

  it('lists merged config providers without printing header values', async () => {
    const io = await createTestIo()

    await writeSetupConfig(getProjectSetupConfigPath(io.cwd), {
      providers: [
        {
          endpoint: 'http://localhost:11434/v1',
          headers: { Authorization: 'Bearer secret' },
          id: 'ollama',
          models: [{ id: 'qwen:8b' }, { id: 'qwen:32b' }],
          type: 'openai-compatible',
        },
      ],
      version: 1,
    })

    const exitCode = await executeCli([
      'node',
      'alint',
      'config',
      'providers',
      'ls',
    ], io)

    expect(exitCode).toBe(0)
    expect(io.stdoutText).toBe([
      'id      type               endpoint                   models  ',
      'ollama  openai-compatible  http://localhost:11434/v1  2       ',
      '',
    ].join('\n'))
    expect(io.stdoutText).not.toContain('secret')
  })

  it('shows one provider with header keys only', async () => {
    const io = await createTestIo()

    await writeSetupConfig(getProjectSetupConfigPath(io.cwd), {
      providers: [
        {
          endpoint: 'https://openrouter.ai/api/v1',
          headers: {
            'Authorization': 'Bearer secret',
            'HTTP-Referer': 'https://example.test',
          },
          id: 'openrouter',
          models: [{ id: 'openai/gpt-4.1-mini' }],
          type: 'openai-compatible',
        },
      ],
      version: 1,
    })

    const exitCode = await executeCli([
      'node',
      'alint',
      'config',
      'providers',
      'show',
      'openrouter',
    ], io)

    expect(exitCode).toBe(0)
    expect(io.stdoutText).toContain('id: openrouter\n')
    expect(io.stdoutText).toContain('endpoint: https://openrouter.ai/api/v1\n')
    expect(io.stdoutText).toContain('models: openai/gpt-4.1-mini\n')
    expect(io.stdoutText).toContain('headers: Authorization, HTTP-Referer\n')
    expect(io.stdoutText).not.toContain('secret')
    expect(io.stdoutText).not.toContain('example.test')
  })

  it('returns 2 when provider is unknown', async () => {
    const io = await createTestIo()

    const exitCode = await executeCli([
      'node',
      'alint',
      'config',
      'providers',
      'show',
      'missing',
    ], io)

    expect(exitCode).toBe(2)
    expect(io.stderrText).toBe('unknown provider "missing".\n')
  })

  it('probes provider reachability and model count', async () => {
    const io = await createTestIo()
    const server = await withModelsServer(() => ({
      body: { data: [{ id: 'one' }, { id: 'two' }] },
    }))

    try {
      const exitCode = await executeCli([
        'node',
        'alint',
        'config',
        'providers',
        'probe',
        '--endpoint',
        server.endpoint,
      ], io)

      expect(exitCode).toBe(0)
      expect(io.stdoutText).toBe(`endpoint: ${server.endpoint}\nmodels: 2\n`)
    }
    finally {
      await server.close()
    }
  })

  it('prints effective config details for a file', async () => {
    const io = await createTestIo()
    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  { name: 'ignore dist', ignores: ['dist/**'] },
  {
    name: 'go files',
    files: ['**/*.go'],
    language: 'text/plain',
    rules: {
      'review/file': 'warn',
      'review/disabled': 'off',
    },
  },
]
`)

    const code = await executeCli([
      'node',
      'alint',
      'config',
      'inspect',
      'main.go',
    ], io)

    expect(code).toBe(0)
    expect(io.stdoutText).toContain('file: main.go')
    expect(io.stdoutText).toContain('ignored: no')
    expect(io.stdoutText).toContain('  - go files')
    expect(io.stdoutText).toContain('language: text/plain')
    expect(io.stdoutText).toContain('  review/file: warn')
    expect(io.stdoutText).toContain('  review/disabled: off')
    expect(io.stderrText).toBe('')
  })

  it('prints inferred language for config inspect when language is unset', async () => {
    const io = await createTestIo()
    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    name: 'all files',
    files: ['**/*.txt'],
    rules: {
      'review/file': 'warn',
    },
  },
]
`)

    const code = await executeCli([
      'node',
      'alint',
      'config',
      'inspect',
      'notes.txt',
    ], io)

    expect(code).toBe(0)
    expect(io.stdoutText).toContain('file: notes.txt')
    expect(io.stdoutText).toContain('  - all files')
    expect(io.stdoutText).toContain('language: <inferred>')
    expect(io.stderrText).toBe('')
  })

  it('uses global custom config for config inspect', async () => {
    const io = await createTestIo()
    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    name: 'default config',
    files: ['**/*.go'],
    language: 'text/plain',
    rules: {
      'default/file': 'warn',
    },
  },
]
`)
    await writeFile(join(io.cwd, 'custom.config.ts'), `
export default [
  {
    name: 'custom config',
    files: ['**/*.go'],
    language: 'text/markdown',
    rules: {
      'custom/file': 'error',
    },
  },
]
`)

    const code = await executeCli([
      'node',
      'alint',
      '--config',
      'custom.config.ts',
      'config',
      'inspect',
      'main.go',
    ], io)

    expect(code).toBe(0)
    expect(io.stdoutText).toContain('  - custom config')
    expect(io.stdoutText).toContain('language: text/markdown')
    expect(io.stdoutText).toContain('  custom/file: error')
    expect(io.stdoutText).not.toContain('default config')
    expect(io.stdoutText).not.toContain('default/file')
    expect(io.stderrText).toBe('')
  })

  it('prints help and returns 0', async () => {
    const io = await createTestIo()

    const exitCode = await executeCli(['node', 'alint', '--help'], io)

    expect(exitCode).toBe(0)
    expect(io.stdoutText).toContain('alint')
    expect(io.stdoutText).toContain('Examples:')
    expect(io.stdoutText).toContain('alint setup')
    expect(io.stdoutText).toContain('alint src')
    expect(io.stdoutText).toContain('alint --format json src > alint-output.json')
    expect(io.stdoutText).toContain('alint output inspect alint-output.json')
    expect(io.stdoutText).toContain('alint config inspect src/index.ts')
    expect(io.stdoutText).toContain('--no-cache')
    expect(io.stdoutText).toContain('-l, --lang <language>')
    expect(io.stdoutText).not.toMatch(/(^|\n)\s*--cache(?:\s|,)/)
    expect(io.stdoutText).not.toContain('-L')
    expect(io.stdoutText).not.toContain('--output-language')
  })

  it('prints setup examples in setup help', async () => {
    const io = await createTestIo()

    const exitCode = await executeCli(['node', 'alint', 'setup', '--help'], io)

    expect(exitCode).toBe(0)
    expect(io.stdoutText).toContain('Examples:')
    expect(io.stdoutText).toContain('alint setup')
    expect(io.stdoutText).toContain('alint setup --local -N --provider-id openrouter')
    expect(io.stdoutText).toContain('--provider-model z-ai/glm-5.2')
    expect(io.stdoutText).toContain('--provider-header "Authorization=Bearer $OPENROUTER_API_KEY"')
    expect(io.stderrText).toBe('')
  })

  it('returns 2 when non-interactive setup is missing provider endpoint', async () => {
    const io = await createTestIo()

    const exitCode = await executeCli([
      'node',
      'alint',
      'setup',
      '-N',
      '--local',
      '--provider-model',
      'qwen:8b',
    ], io)

    expect(exitCode).toBe(2)
    expect(io.stderrText).toBe('setup requires --provider-endpoint in --no-interactive mode.\n')
  })

  it('returns 2 when non-interactive setup is missing provider id', async () => {
    const io = await createTestIo()

    const exitCode = await executeCli([
      'node',
      'alint',
      'setup',
      '-N',
      '--local',
      '--provider-endpoint',
      'http://localhost:11434/v1',
      '--provider-model',
      'qwen:8b',
    ], io)

    expect(exitCode).toBe(2)
    expect(io.stderrText).toBe('setup requires --provider-id in --no-interactive mode.\n')
  })

  it('returns 2 when interactive setup is requested without a TTY', async () => {
    const io = await createTestIo()

    const exitCode = await executeCli([
      'node',
      'alint',
      'setup',
    ], io)

    expect(exitCode).toBe(2)
    expect(io.stderrText).toBe('interactive setup requires a TTY. Use -N/--no-interactive with --provider-id and --provider-endpoint.\n')
  })

  it('formats diagnostics for the default run command and returns 1 when diagnostics exist', async () => {
    const io = await createTestIo()

    await writeFile(join(io.cwd, 'demo.ts'), [
      'export function load() {',
      '  return 1',
      '}',
      '',
    ].join('\n'))

    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    files: ['**/*.ts'],
    plugins: {
      company: {
        rules: {
        'prefer-load': {
          create: (ctx) => ({
            onTarget: async (target) => {
              if (target.kind !== 'function') return
              ctx.report({
                filePath: target.file.path,
                message: 'Problem found',
                loc: target.loc,
              })
            },
          }),
        },
      },
    },
    },
    rules: {
      'company/prefer-load': 'warn',
    },
  },
]
`)

    const exitCode = await executeCli([
      'node',
      'alint',
      'demo.ts',
    ], io)

    expect(exitCode).toBe(1)
    expect(io.stdoutText).toContain('Problem found')
    expect(io.stdoutText).toContain('company/prefer-load')
  })

  it('returns 2 when a positional file path does not exist', async () => {
    const io = await createTestIo()

    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    files: ['**/*.ts'],
    rules: {},
  },
]
`)

    const exitCode = await executeCli([
      'node',
      'alint',
      'missing.ts',
    ], io)

    expect(exitCode).toBe(2)
    expect(io.stderrText).toBe('No files matching "missing.ts" were found.\n')
    expect(io.stdoutText).toBe('')
  })

  it('discovers files from flat config files patterns when no positional files are passed', async () => {
    const io = await createTestIo()
    await mkdir(join(io.cwd, 'src'), { recursive: true })
    await writeFile(join(io.cwd, 'src/main.go'), 'package main\n')
    await writeFile(join(io.cwd, 'README.md'), '# demo\n')
    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    files: ['src/**/*.go'],
    language: 'text/plain',
    plugins: {
      review: {
        rules: {
          file: {
            create: ctx => ({
              onTarget: target => ctx.report({
                filePath: target.file.path,
                message: 'checked ' + target.language,
              }),
            }),
          },
        },
      },
    },
    rules: {
      'review/file': 'warn',
    },
  },
]
`)

    const code = await executeCli(['node', 'alint'], io)

    expect(code).toBe(1)
    expect(io.stdoutText).toContain('checked text/plain')
    expect(io.stdoutText).toContain('src/main.go')
    expect(io.stdoutText).not.toContain('README.md')
  })

  it('returns 0 without walking directories when config has no files patterns', async () => {
    const io = await createTestIo()
    const blockedDir = join(io.cwd, 'blocked')
    await mkdir(blockedDir)
    await writeFile(join(blockedDir, 'demo.ts'), 'export const visited = true\n')
    await chmod(blockedDir, 0o000)

    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    plugins: {
      review: {
        rules: {
          file: {
            create: ctx => ({
              onTarget: target => ctx.report({
                filePath: target.file.path,
                message: 'visited ' + target.file.path,
              }),
            }),
          },
        },
      },
    },
    rules: {
      'review/file': 'warn',
    },
  },
]
`)

    try {
      const code = await executeCli(['node', 'alint'], io)

      expect(code).toBe(0)
      expect(io.stdoutText).toBe('')
      expect(io.stderrText).toBe('')
    }
    finally {
      await chmod(blockedDir, 0o700)
    }
  })

  it('expands positional directories using flat config files patterns', async () => {
    const io = await createTestIo()
    await mkdir(join(io.cwd, 'src'), { recursive: true })
    await writeFile(join(io.cwd, 'src/main.go'), 'package main\n')
    await writeFile(join(io.cwd, 'src/README.md'), '# demo\n')
    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    files: ['src/**/*.go'],
    language: 'text/plain',
    plugins: {
      review: {
        rules: {
          file: {
            create: ctx => ({
              onTarget: target => ctx.report({
                filePath: target.file.path,
                message: 'checked ' + target.language,
              }),
            }),
          },
        },
      },
    },
    rules: {
      'review/file': 'warn',
    },
  },
]
`)

    const code = await executeCli(['node', 'alint', 'src'], io)

    expect(code).toBe(1)
    expect(io.stdoutText).toContain('checked text/plain')
    expect(io.stdoutText).toContain('src/main.go')
    expect(io.stdoutText).not.toContain('src/README.md')
  })

  it('expands positional glob patterns using config files patterns', async () => {
    const io = await createTestIo()
    await mkdir(join(io.cwd, 'src/nested'), { recursive: true })
    await writeFile(join(io.cwd, 'src/main.ts'), 'export const main = 1\n')
    await writeFile(join(io.cwd, 'src/nested/feature.ts'), 'export const feature = 1\n')
    await writeFile(join(io.cwd, 'src/nested/feature.test.ts'), 'export const test = 1\n')
    await writeFile(join(io.cwd, 'src/readme.md'), '# demo\n')
    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    language: 'text/plain',
    plugins: {
      review: {
        rules: {
          file: {
            create: ctx => ({
              onTarget: target => ctx.report({
                filePath: target.file.path,
                message: 'visited ' + target.file.path,
              }),
            }),
          },
        },
      },
    },
    rules: {
      'review/file': 'warn',
    },
  },
  {
    files: [['src/**/*.ts', '!src/**/*.test.ts']],
  },
]
`)

    const code = await executeCli(['node', 'alint', '--format', 'json', 'src/**/*.ts'], io)
    const diagnostics = JSON.parse(io.stdoutText).diagnostics

    expect(code).toBe(1)
    expect(diagnostics.map((diagnostic: { filePath: string }) => diagnostic.filePath).sort()).toEqual([
      join(io.cwd, 'src/main.ts'),
      join(io.cwd, 'src/nested/feature.ts'),
    ])
  })

  it('passes --lang to rule context', async () => {
    const io = await createTestIo()
    await writeOutputLanguageFixture(io.cwd)

    const code = await executeCli([
      'node',
      'alint',
      '--lang',
      '日本語',
      'demo.ts',
    ], io)

    expect(code).toBe(1)
    expect(io.stdoutText).toContain('answer in 日本語')
  })

  it('passes short language flag to rule context', async () => {
    const io = await createTestIo()
    await writeOutputLanguageFixture(io.cwd)

    const code = await executeCli([
      'node',
      'alint',
      '-l',
      'English',
      'demo.ts',
    ], io)

    expect(code).toBe(1)
    expect(io.stdoutText).toContain('answer in English')
  })

  it('discovers files from nested AND files patterns when no positional files are passed', async () => {
    const io = await createTestIo()
    await mkdir(join(io.cwd, 'src'), { recursive: true })
    await writeFile(join(io.cwd, 'src/main.ts'), 'export const main = 1\n')
    await writeFile(join(io.cwd, 'src/main.test.ts'), 'export const test = 1\n')
    await writeFile(join(io.cwd, 'main.test.ts'), 'export const rootTest = 1\n')
    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    language: 'text/plain',
    plugins: {
      review: {
        rules: {
          file: {
            create: ctx => ({
              onTarget: target => ctx.report({
                filePath: target.file.path,
                message: 'visited ' + target.file.path,
              }),
            }),
          },
        },
      },
    },
    rules: {
      'review/file': 'warn',
    },
  },
  {
    files: [['src/**/*.ts', '**/*.test.ts']],
  },
]
`)

    const code = await executeCli(['node', 'alint', '--format', 'json'], io)
    const diagnostics = JSON.parse(io.stdoutText).diagnostics

    expect(code).toBe(1)
    expect(diagnostics.map((diagnostic: { filePath: string }) => diagnostic.filePath).sort()).toEqual([
      join(io.cwd, 'src/main.test.ts'),
    ])
  })

  it('discovers files from basePath config files patterns when no positional files are passed', async () => {
    const io = await createTestIo()
    await mkdir(join(io.cwd, 'packages/core/src'), { recursive: true })
    await mkdir(join(io.cwd, 'packages/cli/src'), { recursive: true })
    await writeFile(join(io.cwd, 'packages/core/src/demo.ts'), 'export const core = 1\n')
    await writeFile(join(io.cwd, 'packages/cli/src/demo.ts'), 'export const cli = 1\n')
    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    basePath: 'packages/core',
    files: ['src/**/*.ts'],
    language: 'text/plain',
    plugins: {
      review: {
        rules: {
          file: {
            create: ctx => ({
              onTarget: target => ctx.report({
                filePath: target.file.path,
                message: 'visited ' + target.file.path,
              }),
            }),
          },
        },
      },
    },
    rules: {
      'review/file': 'warn',
    },
  },
]
`)

    const code = await executeCli(['node', 'alint', '--format', 'json'], io)
    const diagnostics = JSON.parse(io.stdoutText).diagnostics

    expect(code).toBe(1)
    expect(diagnostics.map((diagnostic: { filePath: string }) => diagnostic.filePath)).toEqual([
      join(io.cwd, 'packages/core/src/demo.ts'),
    ])
  })

  it('discovers files from inline extends files patterns when no positional files are passed', async () => {
    const io = await createTestIo()
    await mkdir(join(io.cwd, 'generated'), { recursive: true })
    await writeFile(join(io.cwd, 'generated/demo.txt'), 'generated\n')
    await writeFile(join(io.cwd, 'manual.txt'), 'manual\n')
    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    extends: [
      {
        files: ['generated/**/*.txt'],
      },
    ],
    language: 'text/plain',
    plugins: {
      review: {
        rules: {
          file: {
            create: ctx => ({
              onTarget: target => ctx.report({
                filePath: target.file.path,
                message: 'visited ' + target.file.path,
              }),
            }),
          },
        },
      },
    },
    rules: {
      'review/file': 'warn',
    },
  },
]
`)

    const code = await executeCli(['node', 'alint', '--format', 'json'], io)
    const diagnostics = JSON.parse(io.stdoutText).diagnostics

    expect(code).toBe(1)
    expect(diagnostics.map((diagnostic: { filePath: string }) => diagnostic.filePath)).toEqual([
      join(io.cwd, 'generated/demo.txt'),
    ])
  })

  it('discovers files from plugin extends inherited matcher scopes when no positional files are passed', async () => {
    const io = await createTestIo()
    await mkdir(join(io.cwd, 'src'), { recursive: true })
    await writeFile(join(io.cwd, 'src/main.go'), 'package main\n')
    await writeFile(join(io.cwd, 'main.go'), 'package main\n')
    await writeFile(join(io.cwd, 'alint.config.ts'), `
const review = {
  configs: {
    recommended: [
      {
        language: 'text/plain',
        rules: {
          'review/file': 'warn',
        },
      },
    ],
  },
  rules: {
    file: {
      create: ctx => ({
        onTarget: target => ctx.report({
          filePath: target.file.path,
          message: 'visited ' + target.file.path,
        }),
      }),
    },
  },
}

export default [
  {
    extends: ['review/recommended'],
    files: ['src/**/*.go'],
    plugins: { review },
  },
]
`)

    const code = await executeCli(['node', 'alint', '--format', 'json'], io)
    const diagnostics = JSON.parse(io.stdoutText).diagnostics

    expect(code).toBe(1)
    expect(diagnostics.map((diagnostic: { filePath: string }) => diagnostic.filePath)).toEqual([
      join(io.cwd, 'src/main.go'),
    ])
  })

  it('discovers files from nested AND files patterns with negated entries', async () => {
    const io = await createTestIo()
    await mkdir(join(io.cwd, 'src'), { recursive: true })
    await writeFile(join(io.cwd, 'src/demo.ts'), 'export const demo = 1\n')
    await writeFile(join(io.cwd, 'src/demo.test.ts'), 'export const test = 1\n')
    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    language: 'text/plain',
    plugins: {
      review: {
        rules: {
          file: {
            create: ctx => ({
              onTarget: target => ctx.report({
                filePath: target.file.path,
                message: 'visited ' + target.file.path,
              }),
            }),
          },
        },
      },
    },
    rules: {
      'review/file': 'warn',
    },
  },
  {
    files: [['src/**/*.ts', '!src/**/*.test.ts']],
  },
]
`)

    const code = await executeCli(['node', 'alint', '--format', 'json'], io)
    const diagnostics = JSON.parse(io.stdoutText).diagnostics

    expect(code).toBe(1)
    expect(diagnostics.map((diagnostic: { filePath: string }) => diagnostic.filePath)).toEqual([
      join(io.cwd, 'src/demo.ts'),
    ])
  })

  it('does not discover files under ignored directories when no positional files are passed', async () => {
    const io = await createTestIo()
    await mkdir(join(io.cwd, 'src'), { recursive: true })
    await mkdir(join(io.cwd, 'ignored'), { recursive: true })
    await mkdir(join(io.cwd, 'gitignored'), { recursive: true })
    await mkdir(join(io.cwd, 'node_modules/pkg'), { recursive: true })
    await writeFile(join(io.cwd, '.gitignore'), 'gitignored/\n')
    await writeFile(join(io.cwd, 'src/demo.txt'), 'demo\n')
    await writeFile(join(io.cwd, 'ignored/demo.txt'), 'ignored\n')
    await writeFile(join(io.cwd, 'gitignored/demo.txt'), 'gitignored\n')
    await writeFile(join(io.cwd, 'node_modules/pkg/demo.txt'), 'dependency\n')
    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    ignores: ['ignored/**', 'node_modules/**'],
  },
  {
    ignore: {
      gitignore: true,
    },
  },
  {
    files: ['**/*.txt'],
    language: 'text/plain',
    plugins: {
      review: {
        rules: {
          file: {
            create: ctx => ({
              onTarget: target => ctx.report({
                filePath: target.file.path,
                message: 'visited ' + target.file.path,
              }),
            }),
          },
        },
      },
    },
    rules: {
      'review/file': 'warn',
    },
  },
]
`)

    const code = await executeCli(['node', 'alint', '--format', 'json'], io)
    const diagnostics = JSON.parse(io.stdoutText).diagnostics

    expect(code).toBe(1)
    expect(diagnostics.map((diagnostic: { filePath: string }) => diagnostic.filePath)).toEqual([
      join(io.cwd, 'src/demo.txt'),
    ])
  })

  it('discovers explicitly configured files under node_modules when not ignored', async () => {
    const io = await createTestIo()
    await mkdir(join(io.cwd, 'node_modules/pkg'), { recursive: true })
    await writeFile(join(io.cwd, 'node_modules/pkg/demo.txt'), 'dependency\n')
    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    files: ['node_modules/pkg/**/*.txt'],
    language: 'text/plain',
    plugins: {
      review: {
        rules: {
          file: {
            create: ctx => ({
              onTarget: target => ctx.report({
                filePath: target.file.path,
                message: 'visited ' + target.file.path,
              }),
            }),
          },
        },
      },
    },
    rules: {
      'review/file': 'warn',
    },
  },
]
`)

    const code = await executeCli(['node', 'alint', '--format', 'json'], io)
    const diagnostics = JSON.parse(io.stdoutText).diagnostics

    expect(code).toBe(1)
    expect(diagnostics.map((diagnostic: { filePath: string }) => diagnostic.filePath)).toEqual([
      join(io.cwd, 'node_modules/pkg/demo.txt'),
    ])
  })

  it('lints gitignored positional files when gitignore filtering is not enabled', async () => {
    const io = await createTestIo()

    await mkdir(join(io.cwd, 'src'), { recursive: true })
    await writeFile(join(io.cwd, 'src/.gitignore'), 'generated.ts\n')
    await writeFile(join(io.cwd, 'src/included.ts'), 'export const included = 1\n')
    await writeFile(join(io.cwd, 'src/generated.ts'), 'export const generated = 1\n')
    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    files: ['**/*.ts'],
    plugins: {
      company: {
        rules: {
        'visit-file': {
          create: (ctx) => ({
            onTarget: async (target) => {
              if (target.kind !== 'file') return
              ctx.report({
                filePath: target.file.path,
                message: 'visited ' + target.file.path,
              })
            },
          }),
        },
      },
    },
    },
    rules: {
      'company/visit-file': 'warn',
    },
  },
]
`)

    const exitCode = await executeCli([
      'node',
      'alint',
      '--format',
      'json',
      'src/included.ts',
      'src/generated.ts',
    ], io)

    const diagnostics = JSON.parse(io.stdoutText).diagnostics

    expect(exitCode).toBe(1)
    expect(diagnostics.map((diagnostic: { filePath: string }) => diagnostic.filePath).sort()).toEqual([
      join(io.cwd, 'src/generated.ts'),
      join(io.cwd, 'src/included.ts'),
    ])
  })

  it('skips gitignored positional files when gitignore filtering is enabled', async () => {
    const io = await createTestIo()

    await mkdir(join(io.cwd, 'src'), { recursive: true })
    await writeFile(join(io.cwd, 'src/.gitignore'), 'generated.ts\n')
    await writeFile(join(io.cwd, 'src/included.ts'), 'export const included = 1\n')
    await writeFile(join(io.cwd, 'src/generated.ts'), 'export const generated = 1\n')
    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    ignore: {
      gitignore: true,
    },
  },
  {
    files: ['**/*.ts'],
    plugins: {
      company: {
        rules: {
        'visit-file': {
          create: (ctx) => ({
            onTarget: async (target) => {
              if (target.kind !== 'file') return
              ctx.report({
                filePath: target.file.path,
                message: 'visited ' + target.file.path,
              })
            },
          }),
        },
      },
    },
    },
    rules: {
      'company/visit-file': 'warn',
    },
  },
]
`)

    const exitCode = await executeCli([
      'node',
      'alint',
      '--format',
      'json',
      'src/included.ts',
      'src/generated.ts',
    ], io)

    const diagnostics = JSON.parse(io.stdoutText).diagnostics

    expect(exitCode).toBe(1)
    expect(diagnostics.map((diagnostic: { filePath: string }) => diagnostic.filePath)).toEqual([
      join(io.cwd, 'src/included.ts'),
    ])
  })

  it('does not let rule console output corrupt json reporter stdout', async () => {
    const io = await createTestIo()

    await writeFile(join(io.cwd, 'demo.ts'), 'export function load() {}\n')
    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    files: ['**/*.ts'],
    plugins: {
      company: {
        rules: {
        'noisy': {
          create: (ctx) => ({
            onTarget: async (target) => {
              if (target.kind !== 'function') return
              console.debug('debug noise')
              console.dir({ dir: 'noise' })
              console.info('info noise')
              console.log('log noise')
              ctx.report({
                filePath: target.file.path,
                message: 'Problem found',
              })
            },
          }),
        },
      },
    },
    },
    rules: {
      'company/noisy': 'warn',
    },
  },
]
`)

    const exitCode = await executeCli([
      'node',
      'alint',
      '--format',
      'json',
      'demo.ts',
    ], io)

    expect(exitCode).toBe(1)
    expect(JSON.parse(io.stdoutText).diagnostics[0].message).toBe('Problem found')
    expect(io.stdoutText).not.toContain('debug noise')
    expect(io.stdoutText).not.toContain('dir')
    expect(io.stdoutText).not.toContain('info noise')
    expect(io.stdoutText).not.toContain('log noise')
    expect(io.stderrText).toContain('debug noise')
    expect(io.stderrText).toContain('dir')
    expect(io.stderrText).toContain('info noise')
    expect(io.stderrText).toContain('log noise')
  })

  it('keeps json stdout clean when progress is not explicitly enabled', async () => {
    const io = await createTestIo()

    await writeProgressFixture(io.cwd)

    const exitCode = await executeCli([
      'node',
      'alint',
      '--format',
      'json',
      'demo.ts',
    ], io)

    expect(exitCode).toBe(1)
    expect(JSON.parse(io.stdoutText).diagnostics[0].message).toBe('Problem found')
    expect(io.stderrText).toBe('')
  })

  it('writes plain progress to stderr when --progress is explicit in non-tty mode', async () => {
    const io = await createTestIo()

    await writeProgressFixture(io.cwd)

    const exitCode = await executeCli([
      'node',
      'alint',
      '--progress',
      'demo.ts',
    ], io)

    expect(exitCode).toBe(1)
    expect(io.stderrText).toContain('alint started')
    expect(io.stderrText).toContain('scan ')
    expect(io.stderrText).toContain('alint finished')
    expect(io.stdoutText).toContain('Problem found')
    expect(io.stdoutText).toContain('company/prefer-load')
  })

  it('does not create progress output when --no-progress is explicit', async () => {
    const io = await createTestIo()
    io.stderr.isTTY = true

    await writeProgressFixture(io.cwd)

    const exitCode = await executeCli([
      'node',
      'alint',
      '--no-progress',
      'demo.ts',
    ], io)

    expect(exitCode).toBe(1)
    expect(io.stderrText).toBe('')
    expect(io.stdoutText).toContain('Problem found')
  })

  it('rejects invalid runner options', async () => {
    const io = await createTestIo()

    await writeProgressFixture(io.cwd)

    await expect(executeCli([
      'node',
      'alint',
      '--file-concurrency',
      '0',
      'demo.ts',
    ], io)).rejects.toThrow('--file-concurrency must be a positive integer.')
  })

  it('writes the default cache and reuses it on the next run', async () => {
    const io = await createTestIo()

    await writeCacheFixture(io.cwd)

    const firstExitCode = await executeCli([
      'node',
      'alint',
      '--format',
      'json',
      'demo.ts',
    ], io)

    expect(firstExitCode).toBe(1)
    expect(JSON.parse(io.stdoutText).diagnostics[0].message).toBe('checked 1')
    await expect(readFile(join(io.cwd, '.alintcache'), 'utf8')).resolves.toContain('"entries"')

    io.stdoutText = ''
    io.stderrText = ''
    const secondExitCode = await executeCli([
      'node',
      'alint',
      '--format',
      'json',
      'demo.ts',
    ], io)

    expect(secondExitCode).toBe(1)
    expect(JSON.parse(io.stdoutText).diagnostics[0].message).toBe('checked 1')
  })

  it('writes and reads the requested cache location', async () => {
    const io = await createTestIo()
    const cachePath = join(io.cwd, 'custom-cache.json')

    await writeCacheFixture(io.cwd)

    const firstExitCode = await executeCli([
      'node',
      'alint',
      '--format',
      'json',
      '--cache-location',
      cachePath,
      'demo.ts',
    ], io)

    expect(firstExitCode).toBe(1)
    expect(JSON.parse(io.stdoutText).diagnostics[0].message).toBe('checked 1')
    await expect(readFile(cachePath, 'utf8')).resolves.toContain('"entries"')

    io.stdoutText = ''
    io.stderrText = ''
    const secondExitCode = await executeCli([
      'node',
      'alint',
      '--format',
      'json',
      '--cache-location',
      cachePath,
      'demo.ts',
    ], io)

    expect(secondExitCode).toBe(1)
    expect(JSON.parse(io.stdoutText).diagnostics[0].message).toBe('checked 1')
  })

  it('forces execution with --no-cache even when cache entries exist', async () => {
    const io = await createTestIo()

    await writeCacheFixture(io.cwd)

    const firstExitCode = await executeCli([
      'node',
      'alint',
      '--format',
      'json',
      'demo.ts',
    ], io)

    expect(firstExitCode).toBe(1)
    expect(JSON.parse(io.stdoutText).diagnostics[0].message).toBe('checked 1')

    io.stdoutText = ''
    io.stderrText = ''
    const secondExitCode = await executeCli([
      'node',
      'alint',
      '--format',
      'json',
      '--no-cache',
      'demo.ts',
    ], io)

    expect(secondExitCode).toBe(1)
    expect(JSON.parse(io.stdoutText).diagnostics[0].message).toBe('checked 2')
  })

  it('preserves disabled setup cache when project config only overrides cache location', async () => {
    const io = await createTestIo()
    const cachePath = join(io.cwd, 'custom.json')

    await writeSetupConfig(getProjectSetupConfigPath(io.cwd), {
      providers: [],
      runner: {
        cache: { enabled: false },
      },
      version: 1,
    })
    await writeCacheFixture(io.cwd, `
  runner: {
    cache: { location: 'custom.json' },
  },`)

    const firstExitCode = await executeCli([
      'node',
      'alint',
      '--format',
      'json',
      'demo.ts',
    ], io)

    expect(firstExitCode).toBe(1)
    expect(JSON.parse(io.stdoutText).diagnostics[0].message).toBe('checked 1')

    io.stdoutText = ''
    io.stderrText = ''
    const secondExitCode = await executeCli([
      'node',
      'alint',
      '--format',
      'json',
      'demo.ts',
    ], io)

    expect(secondExitCode).toBe(1)
    expect(JSON.parse(io.stdoutText).diagnostics[0].message).toBe('checked 2')
    await expect(readFile(cachePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('lets project config disable setup cache location', async () => {
    const io = await createTestIo()
    const cachePath = join(io.cwd, 'setup-cache.json')

    await writeSetupConfig(getProjectSetupConfigPath(io.cwd), {
      providers: [],
      runner: {
        cache: { location: 'setup-cache.json' },
      },
      version: 1,
    })
    await writeCacheFixture(io.cwd, `
  runner: {
    cache: { enabled: false },
  },`)

    const firstExitCode = await executeCli([
      'node',
      'alint',
      '--format',
      'json',
      'demo.ts',
    ], io)

    expect(firstExitCode).toBe(1)
    expect(JSON.parse(io.stdoutText).diagnostics[0].message).toBe('checked 1')

    io.stdoutText = ''
    io.stderrText = ''
    const secondExitCode = await executeCli([
      'node',
      'alint',
      '--format',
      'json',
      'demo.ts',
    ], io)

    expect(secondExitCode).toBe(1)
    expect(JSON.parse(io.stdoutText).diagnostics[0].message).toBe('checked 2')
    await expect(readFile(cachePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('lets --cache-location override the merged config cache location', async () => {
    const io = await createTestIo()
    const setupCachePath = join(io.cwd, 'setup-cache.json')
    const projectCachePath = join(io.cwd, 'project-cache.json')
    const cliCachePath = join(io.cwd, 'cli-cache.json')

    await writeSetupConfig(getProjectSetupConfigPath(io.cwd), {
      providers: [],
      runner: {
        cache: { location: 'setup-cache.json' },
      },
      version: 1,
    })
    await writeCacheFixture(io.cwd, `
  runner: {
    cache: { location: 'project-cache.json' },
  },`)

    const firstExitCode = await executeCli([
      'node',
      'alint',
      '--format',
      'json',
      '--cache-location',
      cliCachePath,
      'demo.ts',
    ], io)

    expect(firstExitCode).toBe(1)
    expect(JSON.parse(io.stdoutText).diagnostics[0].message).toBe('checked 1')
    await expect(readFile(cliCachePath, 'utf8')).resolves.toContain('"entries"')

    io.stdoutText = ''
    io.stderrText = ''
    const secondExitCode = await executeCli([
      'node',
      'alint',
      '--format',
      'json',
      '--cache-location',
      cliCachePath,
      'demo.ts',
    ], io)

    expect(secondExitCode).toBe(1)
    expect(JSON.parse(io.stdoutText).diagnostics[0].message).toBe('checked 1')
    await expect(readFile(setupCachePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(projectCachePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('formats rule execution failures without interpreting provider payloads', async () => {
    const io = await createTestIo()

    await writeFile(join(io.cwd, 'demo.ts'), 'export function load() {}\n')
    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    files: ['**/*.ts'],
    plugins: {
      company: {
        rules: {
        'remote-fails': {
          create: () => ({
            onTarget: (target) => {
              if (target.kind !== 'function') return
              throw new Error('Remote sent 403 response: {"error":{"message":"The request is prohibited due to a violation of provider Terms Of Service.","code":403},"user_id":"secret"}')
            },
          }),
        },
      },
    },
    },
    rules: {
      'company/remote-fails': 'warn',
    },
  },
]
`)

    const exitCode = await executeCli([
      'node',
      'alint',
      '--progress',
      'demo.ts',
    ], io)

    expect(exitCode).toBe(2)
    expect(io.stderrText).toContain('scan ')
    expect(io.stderrText).toContain('alint failed: 0 warn, 0 error, 0 tokens, 1 errored')
    expect(io.stderrText).toContain('demo.ts > function load > company/remote-fails')
    expect(io.stderrText).toContain('Rule running failed due to Remote sent 403 response:')
    expect(io.stderrText).toContain('"error"')
    expect(io.stderrText).toContain('user_id')
    expect(io.stdoutText).toBe('')
  })

  it('prioritizes project-local setup models over global defaults', async () => {
    const io = await createTestIo()
    const configHome = await mkdtemp(join(tmpdir(), 'alint-config-home-'))
    io.env = {
      ...process.env,
      XDG_CONFIG_HOME: configHome,
    }

    await writeSetupConfig(getGlobalSetupConfigPath(io.env), {
      providers: [
        {
          endpoint: 'http://global.example/v1',
          id: 'global',
          models: [
            {
              capabilities: ['code-review'],
              id: 'global-model',
            },
          ],
          type: 'openai-compatible',
        },
      ],
      version: 1,
    })
    await writeSetupConfig(getProjectSetupConfigPath(io.cwd), {
      providers: [
        {
          endpoint: 'http://project.example/v1',
          id: 'project',
          models: [
            {
              capabilities: ['code-review'],
              id: 'project-model',
            },
          ],
          type: 'openai-compatible',
        },
      ],
      version: 1,
    })
    await writeFile(join(io.cwd, 'demo.ts'), 'export function load() {}\n')
    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default [
  {
    files: ['**/*.ts'],
    plugins: {
      company: {
        rules: {
        'prefer-local': {
          model: { capabilities: ['code-review'] },
          create: (ctx) => ({
            onTarget: async (target) => {
              if (target.kind !== 'function') return
              const model = await ctx.model()
              ctx.report({
                filePath: target.file.path,
                message: 'checked with ' + model.id,
              })
            },
          }),
        },
      },
    },
    },
    rules: {
      'company/prefer-local': 'warn',
    },
  },
]
`)

    const exitCode = await executeCli([
      'node',
      'alint',
      '--format',
      'json',
      'demo.ts',
    ], io)

    expect(exitCode).toBe(1)
    expect(JSON.parse(io.stdoutText).diagnostics[0].message).toBe('checked with project-model')
  })

  it('forwards config model and format options to the run command', async () => {
    const io = await createTestIo()
    const configHome = await mkdtemp(join(tmpdir(), 'alint-config-home-'))
    const configFileName = 'custom.alint.config.ts'
    const configPath = join(io.cwd, configFileName)
    io.env = {
      ...process.env,
      XDG_CONFIG_HOME: configHome,
    }

    await executeCli([
      'node',
      'alint',
      'setup',
      '-N',
      '--provider-id',
      'global',
      '--provider-endpoint',
      'http://localhost:11434/v1',
      '--provider-model',
      'global-model',
    ], io)
    await executeCli([
      'node',
      'alint',
      'setup',
      '-N',
      '--local',
      '--provider-id',
      'project',
      '--provider-endpoint',
      'http://localhost:11434/v1',
      '--provider-model',
      'project-model',
    ], io)
    await writeFile(join(io.cwd, 'demo.ts'), 'export function load() {}\n')
    await writeFile(configPath, `
export default [
  {
    files: ['**/*.ts'],
    plugins: {
      company: {
        rules: {
        'prefer-load': {
          create: (ctx) => ({
            onTarget: async (target) => {
              if (target.kind !== 'function') return
              const model = await ctx.model('global-model')
              ctx.report({
                filePath: target.file.path,
                message: 'checked with ' + model.id,
              })
            },
          }),
        },
      },
    },
    },
    rules: {
      'company/prefer-load': 'warn',
    },
  },
]
`)

    io.stdoutText = ''
    const exitCode = await executeCli([
      'node',
      'alint',
      '--config',
      configFileName,
      '--model',
      'project-model',
      '--format',
      'json',
      'demo.ts',
    ], io)

    const output = JSON.parse(io.stdoutText)

    expect(exitCode).toBe(1)
    expect(output.diagnostics[0]).toMatchObject({
      message: 'checked with project-model',
      model: {
        requested: 'project-model',
        resolvedId: 'project-model',
      },
      ruleId: 'company/prefer-load',
    })
  })

  it('rejects missing explicit config paths', async () => {
    const io = await createTestIo()

    await expect(executeCli([
      'node',
      'alint',
      '--config',
      join(io.cwd, 'missing.alint.config.ts'),
      'demo.ts',
    ], io)).rejects.toThrow(`Config file "${join(io.cwd, 'missing.alint.config.ts')}" does not exist.`)
  })
})
