import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { executeCli } from './cli'
import { getProjectSetupConfigPath } from './config/paths'
import { parseSetupConfigToml, stringifySetupConfigToml } from './config/setup-toml'

interface TestIo {
  cwd: string
  env: NodeJS.ProcessEnv
  stderr: { write: (chunk: string) => void }
  stderrText: string
  stdout: { write: (chunk: string) => void }
  stdoutText: string
}

async function addModelCapabilities(
  setupConfigPath: string,
  capabilities: string[],
): Promise<void> {
  const setupConfig = parseSetupConfigToml(await readFile(setupConfigPath, 'utf8'))
  const provider = setupConfig.providers[0]
  const model = provider?.models[0]

  if (!provider || !model) {
    throw new Error(`Expected a provider model in "${setupConfigPath}".`)
  }

  model.capabilities = capabilities

  await writeFile(setupConfigPath, stringifySetupConfigToml(setupConfig), 'utf8')
}

async function createTestIo(): Promise<TestIo> {
  const cwd = await mkdtemp(join(tmpdir(), 'alint-e2e-'))
  const configHome = await mkdtemp(join(tmpdir(), 'alint-e2e-config-'))
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

describe('alint package entry', () => {
  it('runs setup and executes a capability-gated function rule in a temp project', async () => {
    const io = await createTestIo()
    const demoFilePath = join(io.cwd, 'demo.ts')
    const configSourceUrl = new URL('./index.ts', import.meta.url).href

    await writeFile(demoFilePath, [
      'export function load() { return 1 }',
      '',
    ].join('\n'))

    await writeFile(join(io.cwd, 'alint.config.ts'), [
      `import { defineConfig, definePlugin, defineRule } from '${configSourceUrl}'`,
      '',
      'const reviewLoad = defineRule({',
      '  model: { capabilities: [\'code-review\'] },',
      '  create: ctx => ({',
      '    onFunction: async (fn) => {',
      '      const model = await ctx.model()',
      '      ctx.report({',
      '        filePath: fn.file.path,',
      '        loc: fn.loc,',
      '        message: \'checked \' + fn.name + \' with \' + model.id,',
      '      })',
      '    },',
      '  }),',
      '})',
      '',
      'export default defineConfig({',
      '  plugins: [',
      '    definePlugin({',
      '      rules: {',
      '        \'review-load\': reviewLoad,',
      '      },',
      '      scope: \'fixture\',',
      '    }),',
      '  ],',
      '  rules: {',
      '    \'fixture/review-load\': \'warn\',',
      '  },',
      '})',
      '',
    ].join('\n'))

    const setupExitCode = await executeCli([
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

    expect(setupExitCode).toBe(0)

    await addModelCapabilities(getProjectSetupConfigPath(io.cwd), ['code-review'])

    io.stderrText = ''
    io.stdoutText = ''

    const exitCode = await executeCli([
      'node',
      'alint',
      '--format',
      'json',
      'demo.ts',
    ], io)

    const output = JSON.parse(io.stdoutText)

    expect(exitCode).toBe(1)
    expect(io.stderrText).toBe('')
    expect(output.diagnostics).toHaveLength(1)
    expect(output.diagnostics[0]).toMatchObject({
      filePath: demoFilePath,
      message: 'checked load with qwen:8b',
      ruleId: 'fixture/review-load',
      severity: 'warn',
    })
    expect(output.diagnostics[0].loc).toEqual({
      end: { column: 35, line: 1 },
      start: { column: 7, line: 1 },
    })
  })
})
