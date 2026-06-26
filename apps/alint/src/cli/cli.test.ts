import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { getGlobalSetupConfigPath, getProjectSetupConfigPath } from '../config/paths'
import { writeSetupConfig } from '../config/setup-write'
import { executeCli } from './cli'

interface TestIo {
  cwd: string
  env?: NodeJS.ProcessEnv
  stderr: { columns?: number, isTTY?: boolean, write: (chunk: string) => void }
  stderrText: string
  stdout: { write: (chunk: string) => void }
  stdoutText: string
}

async function createTestIo(): Promise<TestIo> {
  const cwd = await mkdtemp(join(tmpdir(), 'alint-cli-'))
  const io: TestIo = {
    cwd,
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

async function writeCacheFixture(cwd: string, runnerConfig = ''): Promise<void> {
  await writeFile(join(cwd, 'demo.ts'), 'export function load() {}\n')
  const callKey = `__alintCacheFixtureCalls_${cwd}`
  await writeFile(join(cwd, 'alint.config.ts'), `
const callKey = ${JSON.stringify(callKey)}
globalThis[callKey] = globalThis[callKey] ?? 0

export default {
  plugins: [
    {
      scope: 'company',
      rules: {
        'cached': {
          create: (ctx) => ({
            onFunction: async (functionNode) => {
              globalThis[callKey] += 1
              ctx.report({
                filePath: functionNode.file.path,
                message: 'checked ' + globalThis[callKey],
              })
            },
          }),
        },
      },
    },
  ],
  rules: {
    'company/cached': 'warn',
  },
  ${runnerConfig}
}
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
export default {
  plugins: [
    {
      scope: 'company',
      rules: {
        'prefer-load': {
          create: (ctx) => ({
            onFunction: async (functionNode) => {
              ctx.report({
                filePath: functionNode.file.path,
                message: 'Problem found',
                loc: functionNode.loc,
              })
            },
          }),
        },
      },
    },
  ],
  rules: {
    'company/prefer-load': 'warn',
  },
}
`)
}

describe('executeCli', () => {
  it('writes local setup config and returns 0 for non-interactive setup', async () => {
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

    expect(exitCode).toBe(0)

    const toml = await readFile(getProjectSetupConfigPath(io.cwd), 'utf8')
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
      '--provider-endpoint',
      'http://localhost:11434/v1',
      '--provider-model',
      'qwen:8b',
    ], io)

    expect(exitCode).toBe(0)
    expect(await readFile(getProjectSetupConfigPath(io.cwd), 'utf8')).toContain('id = "qwen:8b"')
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

  it('prints help and returns 0', async () => {
    const io = await createTestIo()

    const exitCode = await executeCli(['node', 'alint', '--help'], io)

    expect(exitCode).toBe(0)
    expect(io.stdoutText).toContain('alint')
    expect(io.stdoutText).toContain('--no-cache')
    expect(io.stdoutText).not.toMatch(/(^|\n)\s*--cache(?:\s|,)/)
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

  it('returns a deferred interactive setup message when setup has no non-interactive inputs', async () => {
    const io = await createTestIo()

    const exitCode = await executeCli([
      'node',
      'alint',
      'setup',
    ], io)

    expect(exitCode).toBe(2)
    expect(io.stderrText).toBe('interactive setup is not implemented yet. Use -N/--no-interactive with --provider-endpoint.\n')
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
export default {
  plugins: [
    {
      scope: 'company',
      rules: {
        'prefer-load': {
          create: (ctx) => ({
            onFunction: async (functionNode) => {
              ctx.report({
                filePath: functionNode.file.path,
                message: 'Problem found',
                loc: functionNode.loc,
              })
            },
          }),
        },
      },
    },
  ],
  rules: {
    'company/prefer-load': 'warn',
  },
}
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

  it('does not let rule console output corrupt json reporter stdout', async () => {
    const io = await createTestIo()

    await writeFile(join(io.cwd, 'demo.ts'), 'export function load() {}\n')
    await writeFile(join(io.cwd, 'alint.config.ts'), `
export default {
  plugins: [
    {
      scope: 'company',
      rules: {
        'noisy': {
          create: (ctx) => ({
            onFunction: async (functionNode) => {
              console.debug('debug noise')
              console.dir({ dir: 'noise' })
              console.info('info noise')
              console.log('log noise')
              ctx.report({
                filePath: functionNode.file.path,
                message: 'Problem found',
              })
            },
          }),
        },
      },
    },
  ],
  rules: {
    'company/noisy': 'warn',
  },
}
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
export default {
  plugins: [
    {
      scope: 'company',
      rules: {
        'remote-fails': {
          create: () => ({
            onFunction: () => {
              throw new Error('Remote sent 403 response: {"error":{"message":"The request is prohibited due to a violation of provider Terms Of Service.","code":403},"user_id":"secret"}')
            },
          }),
        },
      },
    },
  ],
  rules: {
    'company/remote-fails': 'warn',
  },
}
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
export default {
  plugins: [
    {
      scope: 'company',
      rules: {
        'prefer-local': {
          model: { capabilities: ['code-review'] },
          create: (ctx) => ({
            onFunction: async (functionNode) => {
              const model = await ctx.model()
              ctx.report({
                filePath: functionNode.file.path,
                message: 'checked with ' + model.id,
              })
            },
          }),
        },
      },
    },
  ],
  rules: {
    'company/prefer-local': 'warn',
  },
}
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
      '--provider-endpoint',
      'http://localhost:11434/v1',
      '--provider-model',
      'project-model',
    ], io)
    await writeFile(join(io.cwd, 'demo.ts'), 'export function load() {}\n')
    await writeFile(configPath, `
export default {
  plugins: [
    {
      scope: 'company',
      rules: {
        'prefer-load': {
          create: (ctx) => ({
            onFunction: async (functionNode) => {
              const model = await ctx.model('global-model')
              ctx.report({
                filePath: functionNode.file.path,
                message: 'checked with ' + model.id,
              })
            },
          }),
        },
      },
    },
  ],
  rules: {
    'company/prefer-load': 'warn',
  },
}
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
