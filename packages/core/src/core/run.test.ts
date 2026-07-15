import type { AgentAdapter } from '../agent/types'
import type { RunnerConfig, SetupConfig } from '../config/types'
import type { PluginDefinition, ProjectTarget, RuleConfigEntry, RuleDefinition } from '../dsl/types'

import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { requireAgent, RetryableAgentError } from '../agent'
import { defineConfig, definePlugin, defineRule } from '../dsl/define'
import { AlintRunError, runAlint } from './run'

describe('runAlint', () => {
  function createSetupConfig(): SetupConfig {
    return {
      providers: [
        {
          endpoint: 'http://localhost:11434/v1',
          id: 'ollama',
          models: [
            {
              aliases: ['default'],
              capabilities: ['structured-output'],
              id: 'local:qwen-8b',
              name: 'qwen:8b',
              size: 'small',
            },
            {
              aliases: ['override'],
              capabilities: ['structured-output'],
              id: 'local:qwen-32b',
              name: 'qwen:32b',
              size: 'large',
            },
          ],
          type: 'openai-compatible',
        },
      ],
      version: 1,
    }
  }

  function createConfig(
    rules: Record<string, RuleDefinition>,
    enabledRules: Record<string, RuleConfigEntry>,
    pluginExtras: Omit<PluginDefinition, 'rules'> = {},
    itemExtras: Record<string, unknown> = {},
  ) {
    return defineConfig([
      {
        ...itemExtras,
        plugins: {
          company: definePlugin({
            ...pluginExtras,
            rules,
          }),
        },
        rules: enabledRules,
      },
    ])
  }

  async function runSingleAgentRule(options: {
    adapter: AgentAdapter
    runner?: RunnerConfig
  }) {
    const root = await mkdtemp(join(tmpdir(), 'alint-agent-retry-'))
    const filePath = join(root, 'demo.txt')

    await writeFile(filePath, 'hello\n')

    const rule = defineRule({
      create: ctx => ({
        onTargetFile: async (target) => {
          const agent = requireAgent(ctx)
          const { answer } = await agent({
            instructions: 'review',
            model: await ctx.model('default'),
            prompt: target.text,
            tools: [],
          })

          ctx.report({ message: answer })
        },
      }),
    })

    return runAlint({
      config: createConfig(
        { review: rule },
        { 'company/review': 'warn' },
        {},
        { agent: options.adapter, files: ['**/*.txt'], language: 'text/plain' },
      ),
      cwd: root,
      files: [filePath],
      runner: options.runner,
      setupConfig: createSetupConfig(),
    })
  }

  it('does not expose runner clock overrides', () => {
    const options: Parameters<typeof runAlint>[0] = {}

    // @ts-expect-error runner timing must use the real runtime clock.
    expect(options.runner?.clock).toBeUndefined()
    expect(options).toBeDefined()
  })

  it('runs explicit onTargetWith rules for .go through text/plain', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-go-target-'))
    const filePath = join(root, 'main.go')
    const visited: string[] = []

    await writeFile(filePath, 'package main\n')

    const rule = defineRule({
      create: ctx => ({
        onTargetFile: (target) => {
          visited.push(`${target.kind}:${target.language}:${target.text}`)
          ctx.report({
            message: `checked ${target.language}`,
          })
        },
      }),
    })

    const result = await runAlint({
      config: createConfig(
        { review: rule },
        { 'company/review': 'warn' },
        {},
        { files: ['**/*.go'], language: 'text/plain' },
      ),
      cwd: root,
      files: [filePath],
      setupConfig: createSetupConfig(),
    })

    expect(visited).toEqual([
      'file:text/plain:package main\n',
    ])
    expect(result.diagnostics).toMatchObject([
      {
        filePath,
        message: 'checked text/plain',
        ruleId: 'company/review',
        severity: 'warn',
      },
    ])
  })

  it('dispatches source targets only to their specialized handlers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-specialized-targets-'))
    const filePath = join(root, 'demo.ts')
    const visited: string[] = []

    await writeFile(filePath, [
      'export class Demo {}',
      'export function load() {}',
    ].join('\n'))

    const rule = defineRule({
      create: () => ({
        onTargetClass: (target) => {
          visited.push(`class:${target.name}`)
        },
        onTargetFile: (target) => {
          visited.push(`file:${target.file.path}`)
        },
        onTargetFunction: (target) => {
          visited.push(`function:${target.name}`)
        },
      }),
    })

    const result = await runAlint({
      config: createConfig({ review: rule }, { 'company/review': 'warn' }),
      cwd: root,
      files: [filePath],
      setupConfig: createSetupConfig(),
    })

    expect(visited).toEqual([
      `file:${filePath}`,
      'class:Demo',
      'function:load',
    ])
    expect(result.execution).toMatchObject({ completed: 3, planned: 3 })
  })

  it('dispatches onTargetWith across source, directory, and project targets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-target-with-'))
    const filePath = join(root, 'demo.txt')
    const directoryPath = join(root, 'components')
    const visited: string[] = []

    await writeFile(filePath, 'demo\n')

    const rule = defineRule({
      cache: false,
      create: () => ({
        onTargetWith: (target) => {
          visited.push(target.kind)
        },
      }),
    })

    const result = await runAlint({
      config: createConfig(
        { review: rule },
        { 'company/review': 'warn' },
        {},
        { language: 'text/plain' },
      ),
      cwd: root,
      directories: [directoryPath],
      files: [filePath],
      setupConfig: createSetupConfig(),
    })

    expect(visited).toEqual(['file', 'directory', 'project'])
    expect(result.execution).toMatchObject({ completed: 3, planned: 3 })
  })

  it('keeps distinct source target identities for equal names at different ranges', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-source-target-identity-'))
    const filePath = join(root, 'demo.custom')
    const identities: string[] = []

    await writeFile(filePath, 'same\nsame\n')

    const rule = defineRule({
      create: () => ({
        onTargetFunction: (target) => {
          identities.push(target.identity)
        },
      }),
    })

    await runAlint({
      config: createConfig(
        { review: rule },
        { 'company/review': 'warn' },
        {
          languages: {
            custom: {
              extensions: ['.custom'],
              extract: file => [
                {
                  file,
                  identity: 'same',
                  kind: 'function',
                  language: 'custom/plain',
                  name: 'same',
                  range: { end: 4, start: 0 },
                  text: 'same',
                },
                {
                  file,
                  identity: 'same',
                  kind: 'function',
                  language: 'custom/plain',
                  name: 'same',
                  range: { end: 9, start: 5 },
                  text: 'same',
                },
              ],
              name: 'custom/plain',
            },
          },
        },
      ),
      cwd: root,
      files: [filePath],
      setupConfig: createSetupConfig(),
    })

    const cacheFile = JSON.parse(await readFile(join(root, '.alintcache'), 'utf8')) as {
      entries: Record<string, { target: { identity: string } }>
    }
    const normalizedIdentities = Object.values(cacheFile.entries)
      .map(entry => entry.target.identity)
      .sort()

    expect(identities).toEqual(['same', 'same'])
    expect(normalizedIdentities).toEqual([
      'function:same:0:4',
      'function:same:5:9',
    ])
  })

  it('runs onTargetDirectory for matching explicit directories in input order without files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-directory-target-'))
    const componentA = join(root, 'crates', 'a')
    const example = join(root, 'examples', 'c')
    const componentB = join(root, 'crates', 'b')
    const visited: string[] = []

    const rule = defineRule({
      create: ctx => ({
        onTargetDirectory: (target) => {
          visited.push(target.path)
          ctx.report({
            filePath: target.path,
            message: 'checked directory',
          })
        },
      }),
    })

    const result = await runAlint({
      config: createConfig(
        { review: rule },
        { 'company/review': 'warn' },
        {},
        { directories: ['crates/*'] },
      ),
      cwd: root,
      directories: [componentA, example, componentB],
      runner: {
        cache: true,
      },
      setupConfig: createSetupConfig(),
    })

    expect(visited).toEqual([
      componentA,
      componentB,
    ])
    expect(result.diagnostics).toMatchObject([
      {
        filePath: componentA,
        message: 'checked directory',
        ruleId: 'company/review',
        severity: 'warn',
      },
      {
        filePath: componentB,
        message: 'checked directory',
        ruleId: 'company/review',
        severity: 'warn',
      },
    ])
  })

  it('reports contiguous progress indices after inactive directory plans are filtered', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-directory-progress-'))
    const filePath = join(root, 'notes.txt')
    const inactiveDirectory = join(root, 'examples', 'c')
    const activeDirectory = join(root, 'crates', 'a')
    const runFiles: string[] = []
    const startedFiles: string[] = []

    await writeFile(filePath, 'notes\n')

    const fileRule = defineRule({
      create: () => ({
        onTargetWith: () => {},
      }),
    })
    const directoryRule = defineRule({
      create: () => ({
        onTargetDirectory: () => {},
      }),
    })

    await runAlint({
      config: defineConfig([
        {
          files: ['**/*.txt'],
          language: 'text/plain',
          plugins: {
            source: definePlugin({ rules: { check: fileRule } }),
          },
          rules: { 'source/check': 'warn' },
        },
        {
          directories: ['crates/*'],
          plugins: {
            review: definePlugin({ rules: { check: directoryRule } }),
          },
          rules: { 'review/check': 'warn' },
        },
      ]),
      cwd: root,
      directories: [inactiveDirectory, activeDirectory],
      files: [filePath],
      progress: {
        onFileStart: ({ file }) => startedFiles.push(`${file.index}/${file.total}:${file.path}`),
        onRunStart: ({ files }) => runFiles.push(...(files ?? []).map(file => `${file.index}/${file.total}:${file.path}`)),
      },
      setupConfig: createSetupConfig(),
    })

    expect(runFiles).toEqual([
      `1/2:${filePath}`,
      `2/2:${activeDirectory}`,
    ])
    expect(startedFiles).toEqual(runFiles)
  })

  it('does not replay directory targets from cache', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-directory-cache-'))
    const directoryPath = join(root, 'crates', 'a')
    const cachePath = join(root, '.alintcache')
    const ruleEndEvents: string[] = []
    let handlerCalls = 0

    const rule = defineRule({
      create: () => ({
        onTargetDirectory: () => {
          handlerCalls += 1
        },
      }),
    })
    const config = createConfig(
      { review: rule },
      { 'company/review': 'warn' },
      {},
      { directories: ['crates/*'] },
    )

    for (let run = 0; run < 2; run += 1) {
      await runAlint({
        config,
        cwd: root,
        directories: [directoryPath],
        progress: {
          onRuleEnd: payload => ruleEndEvents.push(`${payload.path.target.kind}:${payload.cache}`),
        },
        runner: {
          cache: { location: cachePath },
        },
        setupConfig: createSetupConfig(),
      })
    }

    expect(handlerCalls).toBe(2)
    expect(ruleEndEvents).toEqual([
      'directory:miss',
      'directory:miss',
    ])
  })

  it('retains partial results and directory failure details when onTargetDirectory throws', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-directory-error-'))
    const directoryPath = join(root, 'crates', 'a')
    const runEndEvents: string[] = []
    const rule = defineRule({
      create: ctx => ({
        onTargetDirectory: (target) => {
          ctx.report({
            filePath: target.path,
            message: 'reported before directory failure',
          })
          throw new Error('directory exploded')
        },
      }),
    })

    let runError: unknown

    try {
      await runAlint({
        config: createConfig(
          { review: rule },
          { 'company/review': 'warn' },
          {},
          { directories: ['crates/*'] },
        ),
        cwd: root,
        directories: [directoryPath],
        progress: {
          onRunEnd: payload => runEndEvents.push(`${payload.diagnostics.length}:${payload.errored}/${payload.planned}`),
        },
        setupConfig: createSetupConfig(),
      })
    }
    catch (error) {
      runError = error
    }

    expect(runError).toBeInstanceOf(AlintRunError)
    expect(runError).toMatchObject({
      failure: {
        filePath: directoryPath,
        message: 'directory exploded',
        ruleId: 'company/review',
        target: { kind: 'directory' },
      },
      result: {
        diagnostics: [{
          filePath: directoryPath,
          message: 'reported before directory failure',
        }],
      },
    })
    expect(runEndEvents).toEqual(['1:1/1'])
  })

  it('runs onTargetProject once at cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-project-target-'))
    const visited: string[] = []

    const rule = defineRule({
      create: () => ({
        onTargetProject: (target) => {
          visited.push(`${target.kind}:${target.root}`)
        },
      }),
    })

    await runAlint({
      config: createConfig(
        { review: rule },
        { 'company/review': 'warn' },
      ),
      cwd: root,
      setupConfig: createSetupConfig(),
    })

    expect(visited).toEqual([
      `project:${root}`,
    ])

    const cacheFile = JSON.parse(await readFile(join(root, '.alintcache'), 'utf8')) as {
      entries: Record<string, unknown>
    }

    expect(cacheFile.entries).toEqual({})
  })

  it('provides one project target containing prepared files and source targets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-project-content-'))
    const firstPath = join(root, 'first.ts')
    const secondPath = join(root, 'second.ts')
    const visited: ProjectTarget[] = []

    await writeFile(firstPath, 'export const first = 1\n')
    await writeFile(secondPath, 'export const second = 2\n')

    const rule = defineRule({
      create: () => ({
        onTargetProject: (target) => {
          visited.push(target)
        },
      }),
    })

    await runAlint({
      config: createConfig(
        { review: rule },
        { 'company/review': 'warn' },
      ),
      cwd: root,
      files: [secondPath, firstPath],
      setupConfig: createSetupConfig(),
    })

    expect(visited).toHaveLength(1)
    expect(visited[0]).toMatchObject({
      kind: 'project',
      root,
    })
    expect(visited[0]?.files.map(file => file.path)).toEqual([
      firstPath,
      secondPath,
    ])
    expect(visited[0]?.targets).toEqual(visited[0]?.files.map(file => expect.objectContaining({
      file,
      kind: 'file',
    })))

    const cacheFile = JSON.parse(await readFile(join(root, '.alintcache'), 'utf8')) as {
      entries: Record<string, { target: { kind: string } }>
      files: Record<string, { entries: string[] }>
    }
    const projectEntryKeys = Object.entries(cacheFile.entries)
      .filter(([, entry]) => entry.target.kind === 'project')
      .map(([key]) => key)

    expect(projectEntryKeys).toHaveLength(1)
    expect(cacheFile.files['first.ts']?.entries).toContain(projectEntryKeys[0])
    expect(cacheFile.files['second.ts']?.entries).toContain(projectEntryKeys[0])
  })

  it('invalidates the project cache when participating file content changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-project-cache-content-'))
    const filePath = join(root, 'demo.ts')
    let handlerCalls = 0

    await writeFile(filePath, 'export const value = 1\n')

    const rule = defineRule({
      create: ctx => ({
        onTargetProject: (target) => {
          handlerCalls += 1
          ctx.report({
            filePath: target.files[0]?.path,
            message: target.files[0]?.text ?? '',
          })
        },
      }),
    })
    const config = createConfig(
      { review: rule },
      { 'company/review': 'warn' },
    )
    const first = await runAlint({
      config,
      cwd: root,
      files: [filePath],
      setupConfig: createSetupConfig(),
    })

    await writeFile(filePath, 'export const value = 2\n')

    const second = await runAlint({
      config,
      cwd: root,
      files: [filePath],
      setupConfig: createSetupConfig(),
    })

    expect(handlerCalls).toBe(2)
    expect(first.diagnostics[0]?.message).toBe('export const value = 1\n')
    expect(second.diagnostics[0]?.message).toBe('export const value = 2\n')
  })

  it('invalidates the project cache when file extraction config changes without content changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-project-cache-config-'))
    const filePath = join(root, 'demo.custom')
    const cachePath = join(root, '.alintcache')
    const ruleEndEvents: string[] = []
    let handlerCalls = 0

    await writeFile(filePath, 'unchanged\n')

    const rule = defineRule({
      create: ctx => ({
        onTargetProject: (target) => {
          handlerCalls += 1
          ctx.report({
            filePath: target.files[0]?.path,
            message: String(target.targets[0]?.metadata?.version),
          })
        },
      }),
    })
    const plugin = definePlugin({
      languages: {
        custom: {
          extensions: ['.custom'],
          extract: (file, options) => [{
            file,
            identity: 'file',
            kind: 'file',
            language: 'custom/plain',
            metadata: { version: options.languageOptions.version },
            origin: { physicalPath: file.path },
            text: file.text,
          }],
          name: 'custom/plain',
        },
      },
      rules: { review: rule },
    })
    const createProjectConfig = (version: number) => defineConfig([
      {
        plugins: { company: plugin },
        rules: { 'company/review': 'warn' },
      },
      {
        files: ['**/*.custom'],
        language: 'custom/plain',
        languageOptions: { version },
      },
    ])

    await runAlint({
      config: createProjectConfig(1),
      cwd: root,
      files: [filePath],
      runner: { cache: { location: cachePath } },
      setupConfig: createSetupConfig(),
    })

    const second = await runAlint({
      config: createProjectConfig(2),
      cwd: root,
      files: [filePath],
      progress: {
        onRuleEnd: payload => ruleEndEvents.push(`${payload.path.target.kind}:${payload.cache}`),
      },
      runner: { cache: { location: cachePath } },
      setupConfig: createSetupConfig(),
    })

    expect(handlerCalls).toBe(2)
    expect(second.diagnostics[0]?.message).toBe('2')
    expect(ruleEndEvents).toEqual(['project:miss'])
  })

  it('invalidates the project cache when extracted targets change without config or content changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-project-cache-targets-'))
    const filePath = join(root, 'demo.custom')
    const cachePath = join(root, '.alintcache')
    const ruleEndEvents: string[] = []
    let handlerCalls = 0

    await writeFile(filePath, 'unchanged\n')

    const rule = defineRule({
      create: ctx => ({
        onTargetProject: (target) => {
          handlerCalls += 1
          ctx.report({
            filePath: target.files[0]?.path,
            message: `${target.targets[0]?.text}:${target.targets[0]?.metadata?.version}`,
          })
        },
      }),
    })
    const createProjectConfig = (version: number) => createConfig(
      { review: rule },
      { 'company/review': 'warn' },
      {
        languages: {
          custom: {
            extensions: ['.custom'],
            extract: file => [{
              file,
              identity: 'file',
              kind: 'file',
              language: 'custom/plain',
              metadata: { version },
              origin: { physicalPath: file.path },
              text: `extracted-${version}`,
            }],
            name: 'custom/plain',
          },
        },
      },
      { language: 'custom/plain', languageOptions: { stable: true } },
    )

    await runAlint({
      config: createProjectConfig(1),
      cwd: root,
      files: [filePath],
      runner: { cache: { location: cachePath } },
      setupConfig: createSetupConfig(),
    })

    const second = await runAlint({
      config: createProjectConfig(2),
      cwd: root,
      files: [filePath],
      progress: {
        onRuleEnd: payload => ruleEndEvents.push(`${payload.path.target.kind}:${payload.cache}`),
      },
      runner: { cache: { location: cachePath } },
      setupConfig: createSetupConfig(),
    })

    expect(handlerCalls).toBe(2)
    expect(second.diagnostics[0]?.message).toBe('extracted-2:2')
    expect(ruleEndEvents).toEqual(['project:miss'])
  })

  it('does not run a project handler when the project root is globally ignored', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-project-ignore-'))
    let handlerCalls = 0

    const rule = defineRule({
      create: () => ({
        onTargetProject: () => {
          handlerCalls += 1
        },
      }),
    })

    await runAlint({
      config: defineConfig([
        { ignores: ['**'] },
        createConfig(
          { review: rule },
          { 'company/review': 'warn' },
        ),
      ]),
      cwd: root,
      setupConfig: createSetupConfig(),
    })

    expect(handlerCalls).toBe(0)
  })

  it('requires an explicit filePath for project diagnostics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-project-diagnostic-path-'))
    const rule = defineRule({
      create: ctx => ({
        onTargetProject: () => {
          ctx.report({ message: 'project issue' })
        },
      }),
    })

    await expect(runAlint({
      config: createConfig(
        { review: rule },
        { 'company/review': 'warn' },
      ),
      cwd: root,
      setupConfig: createSetupConfig(),
    })).rejects.toMatchObject({
      message: 'Diagnostic for rule "company/review" is missing filePath.',
      name: 'AlintRunError',
    })
  })

  it('accepts an explicit participating filePath for project diagnostics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-project-diagnostic-file-'))
    const filePath = join(root, 'demo.ts')

    await writeFile(filePath, 'export const demo = true\n')

    const rule = defineRule({
      create: ctx => ({
        onTargetProject: (target) => {
          ctx.report({
            filePath: target.files[0]?.path,
            message: 'project issue',
          })
        },
      }),
    })

    const result = await runAlint({
      config: createConfig(
        { review: rule },
        { 'company/review': 'warn' },
      ),
      cwd: root,
      files: [filePath],
      setupConfig: createSetupConfig(),
    })

    expect(result.diagnostics).toMatchObject([{
      filePath,
      message: 'project issue',
    }])
  })

  it('retains partial results and project failure details when onTargetProject throws', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-project-error-'))
    const filePath = join(root, 'demo.ts')
    const runEndEvents: string[] = []

    await writeFile(filePath, 'export const demo = true\n')

    const rule = defineRule({
      create: ctx => ({
        onTargetProject: (target) => {
          ctx.report({
            filePath: target.files[0]?.path,
            message: 'reported before project failure',
          })
          throw new Error('project exploded')
        },
      }),
    })

    let runError: unknown

    try {
      await runAlint({
        config: createConfig(
          { review: rule },
          { 'company/review': 'warn' },
        ),
        cwd: root,
        files: [filePath],
        progress: {
          onRunEnd: payload => runEndEvents.push(`${payload.diagnostics.length}:${payload.errored}/${payload.planned}`),
        },
        setupConfig: createSetupConfig(),
      })
    }
    catch (error) {
      runError = error
    }

    expect(runError).toBeInstanceOf(AlintRunError)
    expect(runError).toMatchObject({
      failure: {
        filePath: root,
        message: 'project exploded',
        ruleId: 'company/review',
        target: { kind: 'project' },
      },
      result: {
        diagnostics: [{
          filePath,
          message: 'reported before project failure',
        }],
      },
    })
    expect(runEndEvents).toEqual(['1:1/1'])
  })

  it('does not run project handlers configured only for files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-project-file-scope-'))
    const filePath = join(root, 'demo.ts')
    let handlerCalls = 0

    await writeFile(filePath, 'export const demo = true\n')

    const rule = defineRule({
      create: () => ({
        onTargetProject: () => {
          handlerCalls += 1
        },
      }),
    })

    await runAlint({
      config: createConfig(
        { review: rule },
        { 'company/review': 'warn' },
        {},
        { files: ['**/*.ts'] },
      ),
      cwd: root,
      files: [filePath],
      setupConfig: createSetupConfig(),
    })

    expect(handlerCalls).toBe(0)
  })

  it('exposes outputLanguage on rule context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-output-language-'))
    const filePath = join(root, 'demo.ts')

    await writeFile(filePath, 'export function load() {}\n')

    const rule = defineRule({
      create: ctx => ({
        onTargetFile: () => {
          ctx.report({
            message: `output language: ${ctx.outputLanguage}`,
          })
        },
      }),
    })

    const result = await runAlint({
      config: createConfig(
        { review: rule },
        { 'company/review': 'warn' },
      ),
      cwd: root,
      files: [filePath],
      outputLanguage: '简体中文',
      setupConfig: createSetupConfig(),
    })

    expect(result.diagnostics).toMatchObject([
      {
        filePath,
        message: 'output language: 简体中文',
      },
    ])
  })

  it('does not run plugin rules that are registered but not enabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-plugin-disabled-'))
    const filePath = join(root, 'demo.ts')
    let handlerCalls = 0

    await writeFile(filePath, 'export function load() {}\n')

    const rule = defineRule({
      create: () => ({
        onTargetWith: () => {
          handlerCalls += 1
        },
      }),
    })

    const result = await runAlint({
      config: defineConfig([
        {
          plugins: {
            company: definePlugin({
              rules: { disabled: rule },
            }),
          },
        },
      ]),
      files: [filePath],
      setupConfig: createSetupConfig(),
    })

    expect(handlerCalls).toBe(0)
    expect(result.diagnostics).toEqual([])
  })

  it('uses effective settings when creating rule runtimes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-settings-'))
    const filePath = join(root, 'demo.txt')

    await writeFile(filePath, 'hello\n')

    const rule = defineRule({
      create: ctx => ({
        onTargetWith: () => {
          ctx.report({
            message: String(ctx.settings.message),
          })
        },
      }),
    })

    const result = await runAlint({
      config: createConfig(
        { settings: rule },
        { 'company/settings': 'warn' },
        {},
        {
          files: ['**/*.txt'],
          language: 'text/plain',
          settings: { message: 'from effective config' },
        },
      ),
      cwd: root,
      files: [filePath],
      setupConfig: createSetupConfig(),
    })

    expect(result.diagnostics[0]?.message).toBe('from effective config')
  })

  it('wires ctx.agent from the configured agent adapter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-agent-'))
    const filePath = join(root, 'demo.txt')

    await writeFile(filePath, 'hello\n')

    let called = 0
    const adapter = async () => {
      called += 1

      return { answer: 'from the adapter' }
    }

    const rule = defineRule({
      create: ctx => ({
        onTargetFile: async (target) => {
          const agent = requireAgent(ctx)
          const { answer } = await agent({
            instructions: 'review',
            model: await ctx.model('default'),
            prompt: target.text,
            tools: [],
          })

          ctx.report({ message: answer })
        },
      }),
    })

    const result = await runAlint({
      config: createConfig(
        { boundary: rule },
        { 'company/boundary': 'warn' },
        {},
        { agent: adapter, files: ['**/*.txt'], language: 'text/plain' },
      ),
      cwd: root,
      files: [filePath],
      setupConfig: createSetupConfig(),
    })

    expect(called).toBe(1)
    expect(result.diagnostics[0]?.message).toBe('from the adapter')
  })

  it('retries a retryable configured agent with the default agent retries', async () => {
    vi.useFakeTimers()
    let calls = 0

    try {
      const run = runSingleAgentRule({
        adapter: async () => {
          calls += 1
          if (calls < 3)
            throw new RetryableAgentError('temporary failure')
          return { answer: 'recovered' }
        },
      })

      await vi.waitFor(() => expect(calls).toBe(1))
      await vi.advanceTimersByTimeAsync(500)
      await vi.waitFor(() => expect(calls).toBe(2))
      await vi.advanceTimersByTimeAsync(1_000)
      const result = await run

      expect(calls).toBe(3)
      expect(result.diagnostics[0]?.message).toBe('recovered')
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('does not retry an ordinary configured agent error', async () => {
    const failure = new Error('ordinary configured agent failure')
    let calls = 0
    let error: unknown

    try {
      await runSingleAgentRule({
        adapter: async () => {
          calls += 1
          throw failure
        },
      })
    }
    catch (caught) {
      error = caught
    }

    expect(calls).toBe(1)
    expect(error).toBeInstanceOf(AlintRunError)
    if (!(error instanceof AlintRunError))
      throw new TypeError('Expected runSingleAgentRule to reject with AlintRunError.')
    expect(error.message).toBe('ordinary configured agent failure')
    expect(error.cause).toBe(failure)
  })

  it('does not retry a retryable configured agent when agent retries are zero', async () => {
    let calls = 0

    await expect(runSingleAgentRule({
      adapter: async () => {
        calls += 1
        throw new RetryableAgentError('retry disabled')
      },
      runner: { agentRetries: 0 },
    })).rejects.toThrow('retry disabled')

    expect(calls).toBe(1)
  })

  it('rejects invalid agent retries at the run entry point', async () => {
    await expect(runAlint({
      config: [],
      runner: { agentRetries: -1 },
      setupConfig: createSetupConfig(),
    })).rejects.toThrow('Agent retries must be a non-negative integer.')
  })

  it('ctx.agent throws a clear error when no agent is configured', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-agent-missing-'))
    const filePath = join(root, 'demo.txt')

    await writeFile(filePath, 'hello\n')

    const rule = defineRule({
      create: ctx => ({
        onTargetFile: async (target) => {
          const agent = requireAgent(ctx)

          await agent({
            instructions: 'review',
            model: await ctx.model('default'),
            prompt: target.text,
            tools: [],
          })
        },
      }),
    })

    await expect(runAlint({
      config: createConfig(
        { boundary: rule },
        { 'company/boundary': 'warn' },
        {},
        { files: ['**/*.txt'], language: 'text/plain' },
      ),
      cwd: root,
      files: [filePath],
      setupConfig: createSetupConfig(),
    })).rejects.toThrow(/requires an agent/i)
  })

  it('skips ignored files after resolving effective config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-ignore-'))
    const ignoredPath = join(root, 'ignored.ts')
    const checkedPath = join(root, 'checked.ts')
    const visited: string[] = []

    await writeFile(ignoredPath, 'export function ignored() {}\n')
    await writeFile(checkedPath, 'export function checked() {}\n')

    const rule = defineRule({
      create: () => ({
        onTargetFile: (target) => {
          visited.push(target.file.path)
        },
      }),
    })

    await runAlint({
      config: createConfig(
        { visit: rule },
        { 'company/visit': 'warn' },
        {},
        { ignores: ['ignored.ts'] },
      ),
      cwd: root,
      files: [ignoredPath, checkedPath],
      setupConfig: createSetupConfig(),
    })

    expect(visited.every(path => path === checkedPath)).toBe(true)
  })

  it('reports diagnostics with resolved model metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-model-'))
    const filePath = join(root, 'demo.ts')

    await writeFile(filePath, [
      'export function load() {',
      '  return 1',
      '}',
    ].join('\n'))

    const rule = defineRule({
      create: ctx => ({
        onTargetFunction: async (target) => {
          const model = await ctx.model()

          ctx.report({
            evidence: {
              modelName: model.name,
              source: ctx.src.getText(target),
            },
            loc: target.loc,
            message: `loaded by ${model.id}`,
          })
        },
      }),
      model: {
        capabilities: ['structured-output'],
      },
    })

    const result = await runAlint({
      config: createConfig({ 'prefer-load': rule }, { 'company/prefer-load': 'warn' }),
      files: [filePath],
      setupConfig: createSetupConfig(),
    })

    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toMatchObject({
      filePath,
      message: 'loaded by local:qwen-8b',
      model: {
        providerId: 'ollama',
        resolvedId: 'local:qwen-8b',
      },
      ruleId: 'company/prefer-load',
      severity: 'warn',
    })
    expect(result.diagnostics[0]?.loc).toEqual({
      end: { column: 1, line: 3 },
      start: { column: 7, line: 1 },
    })
  })

  it('lets modelOverride force model selection over rule string selectors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-model-override-'))
    const filePath = join(root, 'demo.ts')

    await writeFile(filePath, 'export function load() {}\n')

    const rule = defineRule({
      create: ctx => ({
        onTargetFunction: async (target) => {
          const model = await ctx.model('default')

          ctx.report({
            filePath: target.file.path,
            message: `loaded by ${model.id}`,
          })
        },
      }),
      model: {
        capabilities: ['structured-output'],
      },
    })

    const result = await runAlint({
      config: createConfig({ 'prefer-load': rule }, { 'company/prefer-load': 'warn' }),
      files: [filePath],
      modelOverride: 'override',
      setupConfig: createSetupConfig(),
    })

    expect(result.diagnostics[0]).toMatchObject({
      message: 'loaded by local:qwen-32b',
      model: {
        requested: 'override',
        resolvedId: 'local:qwen-32b',
      },
    })
  })

  it('does not carry model metadata into later reports', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-model-reset-'))
    const filePath = join(root, 'demo.ts')

    await writeFile(filePath, 'export function load() {}\n')

    const rule = defineRule({
      create: ctx => ({
        onTargetFile: async () => {
          await ctx.model()
          ctx.report({
            message: 'with model',
          })
          ctx.report({
            message: 'without model',
          })
        },
      }),
      model: {
        capabilities: ['structured-output'],
      },
    })

    const result = await runAlint({
      config: createConfig({ 'report-twice': rule }, { 'company/report-twice': 'warn' }),
      files: [filePath],
      setupConfig: createSetupConfig(),
    })

    expect(result.diagnostics).toHaveLength(2)
    expect(result.diagnostics[0]?.model?.resolvedId).toBe('local:qwen-8b')
    expect(result.diagnostics[1]?.model).toBeUndefined()
  })

  it('accumulates usage records emitted by rules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-usage-'))
    const filePath = join(root, 'demo.ts')

    await writeFile(filePath, 'export function load() {}\n')

    const rule = defineRule({
      create: ctx => ({
        onTargetFile: (target) => {
          ctx.metering.recordUsage({
            filePath: target.file.path,
            inputTokens: 10,
            metadata: {
              operation: 'judge',
            },
            modelId: 'local:qwen-8b',
            outputTokens: 4,
            providerId: 'ollama',
            totalTokens: 14,
          })
          ctx.metering.recordUsage({
            filePath: target.file.path,
            inputTokens: 3,
            modelId: 'local:qwen-8b',
            outputTokens: 2,
            providerId: 'ollama',
            totalTokens: 5,
          })
        },
      }),
    })

    const result = await runAlint({
      config: createConfig({ 'record-usage': rule }, { 'company/record-usage': 'warn' }),
      files: [filePath],
      setupConfig: createSetupConfig(),
    })

    expect(result.usage).toEqual({
      inputTokens: 13,
      outputTokens: 6,
      records: [
        {
          filePath,
          inputTokens: 10,
          metadata: {
            operation: 'judge',
          },
          modelId: 'local:qwen-8b',
          outputTokens: 4,
          providerId: 'ollama',
          ruleId: 'company/record-usage',
          totalTokens: 14,
        },
        {
          filePath,
          inputTokens: 3,
          modelId: 'local:qwen-8b',
          outputTokens: 2,
          providerId: 'ollama',
          ruleId: 'company/record-usage',
          totalTokens: 5,
        },
      ],
      totalTokens: 19,
    })
  })

  describe('target cache', () => {
    it('reuses existing rule entries when another rule is enabled', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-cache-added-rule-'))
      const filePath = join(root, 'demo.txt')
      const cachePath = join(root, '.alintcache')
      const calls = { first: 0, second: 0 }
      const ruleEndEvents: string[] = []

      await writeFile(filePath, 'unchanged\n')

      const firstRule = defineRule({
        create: () => ({
          onTargetFile: () => {
            calls.first += 1
          },
        }),
      })
      const secondRule = defineRule({
        create: () => ({
          onTargetFile: () => {
            calls.second += 1
          },
        }),
      })

      await runAlint({
        config: createConfig(
          { first: firstRule, second: secondRule },
          { 'company/first': 'warn' },
          {},
          { language: 'text/plain' },
        ),
        files: [filePath],
        runner: { cache: { location: cachePath } },
        setupConfig: createSetupConfig(),
      })

      const result = await runAlint({
        config: createConfig(
          { first: firstRule, second: secondRule },
          { 'company/first': 'warn', 'company/second': 'warn' },
          {},
          { language: 'text/plain' },
        ),
        files: [filePath],
        progress: {
          onRuleEnd: payload => ruleEndEvents.push(`${payload.path.rule.id}:${payload.cache}`),
        },
        runner: { cache: { location: cachePath } },
        setupConfig: createSetupConfig(),
      })

      expect(calls).toEqual({ first: 1, second: 1 })
      expect(ruleEndEvents).toEqual([
        'company/first:hit',
        'company/second:miss',
      ])
      expect(result.execution).toEqual({
        cached: 1,
        completed: 1,
        errored: 0,
        planned: 2,
        skipped: 0,
      })
    })

    it('invalidates a rule entry when its explicit cache key changes', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-cache-rule-key-'))
      const filePath = join(root, 'demo.txt')
      const cachePath = join(root, '.alintcache')
      const ruleEndEvents: string[] = []
      let handlerCalls = 0

      await writeFile(filePath, 'unchanged\n')

      const create = () => ({
        onTargetFile: () => {
          handlerCalls += 1
        },
      })
      const createVersionedConfig = (cacheKey: string) => createConfig(
        { review: defineRule({ cacheKey, create }) },
        { 'company/review': 'warn' },
        {},
        { language: 'text/plain' },
      )

      await runAlint({
        config: createVersionedConfig('prompt-v1'),
        files: [filePath],
        runner: { cache: { location: cachePath } },
        setupConfig: createSetupConfig(),
      })
      await runAlint({
        config: createVersionedConfig('prompt-v2'),
        files: [filePath],
        progress: {
          onRuleEnd: payload => ruleEndEvents.push(payload.cache),
        },
        runner: { cache: { location: cachePath } },
        setupConfig: createSetupConfig(),
      })

      expect(handlerCalls).toBe(2)
      expect(ruleEndEvents).toEqual(['miss'])
    })

    it('reuses cached diagnostics and usage on unchanged targets', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-cache-run-'))
      const filePath = join(root, 'demo.ts')
      const cachePath = join(root, '.alintcache')
      const diagnosticEvents: string[] = []
      const usageEvents: string[] = []
      const ruleEndEvents: string[] = []
      let handlerCalls = 0

      await writeFile(filePath, 'export function load() {}\n')

      const rule = defineRule({
        create: ctx => ({
          onTargetFunction: (target) => {
            handlerCalls += 1
            ctx.report({
              loc: target.loc,
              message: `checked ${target.name}`,
            })
            ctx.metering.recordUsage({
              filePath: target.file.path,
              inputTokens: 7,
              modelId: 'local:qwen-8b',
              outputTokens: 3,
              providerId: 'ollama',
              totalTokens: 10,
            })
          },
        }),
      })
      const config = createConfig({ cached: rule }, { 'company/cached': 'warn' })

      await runAlint({
        config,
        files: [filePath],
        runner: {
          cache: { location: cachePath },
        },
        setupConfig: createSetupConfig(),
      })

      const result = await runAlint({
        config,
        files: [filePath],
        progress: {
          onDiagnostic: payload => diagnosticEvents.push(`${payload.diagnostic.message}:${payload.path?.target.kind}`),
          onRuleEnd: payload => ruleEndEvents.push(`${payload.path.target.kind}:${payload.cache}:${payload.state}`),
          onUsage: payload => usageEvents.push(`${payload.record.totalTokens}:${payload.path?.target.kind}:${payload.total.totalTokens}`),
        },
        runner: {
          cache: { location: cachePath },
        },
        setupConfig: createSetupConfig(),
      })

      expect(handlerCalls).toBe(1)
      expect(result.diagnostics).toMatchObject([
        {
          cached: true,
          filePath,
          message: 'checked load',
          ruleId: 'company/cached',
        },
      ])
      expect(result.usage).toEqual({
        cached: {
          inputTokens: 7,
          outputTokens: 3,
          records: [expect.objectContaining({
            ruleId: 'company/cached',
            totalTokens: 10,
          })],
          totalTokens: 10,
        },
        inputTokens: 0,
        outputTokens: 0,
        records: [],
        totalTokens: 0,
      })
      expect(result.execution).toEqual({
        cached: 1,
        completed: 0,
        errored: 0,
        planned: 1,
        skipped: 0,
      })
      expect(diagnosticEvents).toEqual([
        'checked load:function',
      ])
      expect(usageEvents).toEqual([
        '10:function:0',
      ])
      expect(ruleEndEvents).toEqual([
        'function:hit:completed',
      ])
    })

    it('reruns changed function targets while reusing unchanged siblings', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-cache-siblings-'))
      const filePath = join(root, 'demo.ts')
      const cachePath = join(root, '.alintcache')
      const calls = new Map<string, number>()
      const ruleEndEvents: string[] = []

      await writeFile(filePath, [
        'export function first() {',
        '  return 1',
        '}',
        'export function second() {',
        '  return 2',
        '}',
      ].join('\n'))

      const rule = defineRule({
        create: ctx => ({
          onTargetFunction: (target) => {
            const name = target.name ?? 'anonymous'
            calls.set(name, (calls.get(name) ?? 0) + 1)
            ctx.report({
              message: `${name}:${ctx.src.getText(target).includes('return 3') ? 'changed' : 'original'}`,
            })
          },
        }),
      })
      const config = createConfig({ siblings: rule }, { 'company/siblings': 'warn' })

      await runAlint({
        config,
        files: [filePath],
        runner: {
          cache: { location: cachePath },
        },
        setupConfig: createSetupConfig(),
      })

      await writeFile(filePath, [
        'export function first() {',
        '  return 1',
        '}',
        'export function second() {',
        '  return 3',
        '}',
      ].join('\n'))

      const result = await runAlint({
        config,
        files: [filePath],
        progress: {
          onRuleEnd: payload => ruleEndEvents.push(`${payload.path.target.name ?? payload.path.target.kind}:${payload.cache}`),
        },
        runner: {
          cache: { location: cachePath },
        },
        setupConfig: createSetupConfig(),
      })

      expect(Object.fromEntries(calls)).toEqual({
        first: 1,
        second: 2,
      })
      expect(result.diagnostics.map(diagnostic => diagnostic.message)).toEqual([
        'first:original',
        'second:changed',
      ])
      expect(ruleEndEvents).toEqual([
        'first:hit',
        'second:miss',
      ])
    })

    it('does not cache rules that opt out', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-cache-opt-out-'))
      const filePath = join(root, 'demo.ts')
      const cachePath = join(root, '.alintcache')
      const ruleEndEvents: string[] = []
      let handlerCalls = 0

      await writeFile(filePath, 'export function load() {}\n')

      const rule = defineRule({
        cache: false,
        create: ctx => ({
          onTargetFunction: (target) => {
            handlerCalls += 1
            ctx.report({
              message: `call ${handlerCalls} ${target.name}`,
            })
          },
        }),
      })
      const config = createConfig({ uncached: rule }, { 'company/uncached': 'warn' })

      await runAlint({
        config,
        files: [filePath],
        runner: {
          cache: { location: cachePath },
        },
        setupConfig: createSetupConfig(),
      })
      const result = await runAlint({
        config,
        files: [filePath],
        progress: {
          onRuleEnd: payload => ruleEndEvents.push(`${payload.path.target.kind}:${payload.cache}`),
        },
        runner: {
          cache: { location: cachePath },
        },
        setupConfig: createSetupConfig(),
      })

      expect(handlerCalls).toBe(2)
      expect(result.diagnostics).toMatchObject([
        {
          message: 'call 2 load',
        },
      ])
      expect(ruleEndEvents).toEqual([
        'function:miss',
      ])
    })

    it('invalidates cached entries when effective settings change', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-cache-settings-'))
      const filePath = join(root, 'demo.txt')
      const cachePath = join(root, '.alintcache')
      const ruleEndEvents: string[] = []

      await writeFile(filePath, 'hello\n')

      const rule = defineRule({
        create: ctx => ({
          onTargetFile: () => {
            ctx.report({
              message: String(ctx.settings.message),
            })
          },
        }),
      })
      const createSettingsConfig = (message: string) => createConfig(
        { settings: rule },
        { 'company/settings': 'warn' },
        {},
        {
          language: 'text/plain',
          settings: { message },
        },
      )

      await runAlint({
        config: createSettingsConfig('first'),
        files: [filePath],
        runner: {
          cache: { location: cachePath },
        },
        setupConfig: createSetupConfig(),
      })

      const result = await runAlint({
        config: createSettingsConfig('second'),
        files: [filePath],
        progress: {
          onRuleEnd: payload => ruleEndEvents.push(payload.cache),
        },
        runner: {
          cache: { location: cachePath },
        },
        setupConfig: createSetupConfig(),
      })

      expect(result.diagnostics[0]?.message).toBe('second')
      expect(ruleEndEvents).toEqual([
        'miss',
      ])
    })

    it('invalidates cached entries when output language changes', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-cache-output-language-'))
      const filePath = join(root, 'demo.ts')
      const cachePath = join(root, '.alintcache')
      const ruleEndEvents: string[] = []
      let calls = 0

      await writeFile(filePath, 'export function load() {}\n')

      const rule = defineRule({
        create: ctx => ({
          onTargetFunction: () => {
            calls += 1
            ctx.report({
              message: `checked in ${ctx.outputLanguage}`,
            })
          },
        }),
      })
      const config = createConfig({ language: rule }, { 'company/language': 'warn' })

      await runAlint({
        config,
        cwd: root,
        files: [filePath],
        outputLanguage: 'English',
        runner: {
          cache: { location: cachePath },
        },
        setupConfig: createSetupConfig(),
      })

      const result = await runAlint({
        config,
        cwd: root,
        files: [filePath],
        outputLanguage: '日本語',
        progress: {
          onRuleEnd: payload => ruleEndEvents.push(payload.cache),
        },
        runner: {
          cache: { location: cachePath },
        },
        setupConfig: createSetupConfig(),
      })

      expect(calls).toBe(2)
      expect(result.diagnostics[0]?.message).toBe('checked in 日本語')
      expect(ruleEndEvents).toEqual([
        'miss',
      ])
    })

    it('invalidates cached entries when implicit language resolution changes', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-cache-language-'))
      const filePath = join(root, 'demo.custom')
      const cachePath = join(root, '.alintcache')
      const ruleEndEvents: string[] = []

      await writeFile(filePath, 'hello\n')

      const rule = defineRule({
        create: ctx => ({
          onTargetFile: (target) => {
            ctx.report({
              message: target.language,
            })
          },
        }),
      })
      const createLanguageConfig = (name: string) => createConfig(
        { language: rule },
        { 'company/language': 'warn' },
        {
          languages: {
            custom: {
              extensions: ['.custom'],
              extract: file => [{
                file,
                identity: 'file',
                kind: 'file',
                language: name,
                origin: { physicalPath: file.path },
                text: file.text,
              }],
              name,
            },
          },
        },
      )

      await runAlint({
        config: createLanguageConfig('custom/first'),
        files: [filePath],
        runner: {
          cache: { location: cachePath },
        },
        setupConfig: createSetupConfig(),
      })

      const result = await runAlint({
        config: createLanguageConfig('custom/second'),
        files: [filePath],
        progress: {
          onRuleEnd: payload => ruleEndEvents.push(payload.cache),
        },
        runner: {
          cache: { location: cachePath },
        },
        setupConfig: createSetupConfig(),
      })

      expect(result.diagnostics[0]?.message).toBe('custom/second')
      expect(ruleEndEvents).toEqual([
        'miss',
      ])
    })

    it('invalidates cached entries when target metadata changes without text changes', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-cache-target-metadata-'))
      const filePath = join(root, 'demo.custom')
      const cachePath = join(root, '.alintcache')
      const ruleEndEvents: string[] = []

      await writeFile(filePath, 'hello\n')

      const rule = defineRule({
        create: ctx => ({
          onTargetFile: (target) => {
            ctx.report({
              message: String(target.metadata?.version),
            })
          },
        }),
      })
      const createMetadataConfig = (version: number) => createConfig(
        { metadata: rule },
        { 'company/metadata': 'warn' },
        {
          languages: {
            custom: {
              extensions: ['.custom'],
              extract: file => [{
                file,
                identity: 'file',
                kind: 'file',
                language: 'custom/plain',
                metadata: { version },
                origin: { physicalPath: file.path },
                text: file.text,
              }],
              name: 'custom/plain',
            },
          },
        },
      )

      await runAlint({
        config: createMetadataConfig(1),
        files: [filePath],
        runner: {
          cache: { location: cachePath },
        },
        setupConfig: createSetupConfig(),
      })

      const result = await runAlint({
        config: createMetadataConfig(2),
        files: [filePath],
        progress: {
          onRuleEnd: payload => ruleEndEvents.push(payload.cache),
        },
        runner: {
          cache: { location: cachePath },
        },
        setupConfig: createSetupConfig(),
      })

      expect(result.diagnostics[0]?.message).toBe('2')
      expect(ruleEndEvents).toEqual([
        'miss',
      ])
    })

    it('keeps custom target identities distinct when text and kind match', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-cache-target-identity-'))
      const filePath = join(root, 'demo.custom')
      const cachePath = join(root, '.alintcache')
      const firstRunMessages: string[] = []
      const secondRunMessages: string[] = []

      await writeFile(filePath, 'same\n')

      const rule = defineRule({
        create: ctx => ({
          onTargetFile: (target) => {
            ctx.report({
              message: target.identity,
            })
          },
        }),
      })
      const config = createConfig(
        { identity: rule },
        { 'company/identity': 'warn' },
        {
          languages: {
            custom: {
              extensions: ['.custom'],
              extract: file => ['alpha', 'beta'].map(identity => ({
                file,
                identity,
                kind: 'file',
                language: 'custom/plain',
                origin: { physicalPath: file.path },
                text: file.text,
              })),
              name: 'custom/plain',
            },
          },
        },
      )

      const firstResult = await runAlint({
        config,
        files: [filePath],
        runner: {
          cache: { location: cachePath },
        },
        setupConfig: createSetupConfig(),
      })

      firstRunMessages.push(...firstResult.diagnostics.map(diagnostic => diagnostic.message))

      const secondResult = await runAlint({
        config,
        files: [filePath],
        runner: {
          cache: { location: cachePath },
        },
        setupConfig: createSetupConfig(),
      })

      secondRunMessages.push(...secondResult.diagnostics.map(diagnostic => diagnostic.message))

      expect(firstRunMessages).toEqual([
        'alpha',
        'beta',
      ])
      expect(secondRunMessages).toEqual([
        'alpha',
        'beta',
      ])
    })

    it('emits errored rule end when cache hit diagnostic replay fails', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-cache-replay-error-'))
      const filePath = join(root, 'demo.ts')
      const cachePath = join(root, '.alintcache')
      const events: string[] = []

      await writeFile(filePath, 'export function load() {}\n')

      const rule = defineRule({
        create: ctx => ({
          onTargetWith: (target) => {
            if (target.kind === 'function') {
              ctx.report({
                message: 'cached diagnostic',
              })
            }
          },
        }),
      })
      const config = createConfig({ replay: rule }, { 'company/replay': 'warn' })

      await runAlint({
        config,
        files: [filePath],
        runner: {
          cache: { location: cachePath },
        },
        setupConfig: createSetupConfig(),
      })

      let runError: unknown

      try {
        await runAlint({
          config,
          files: [filePath],
          progress: {
            onDiagnostic: () => {
              throw new Error('diagnostic progress failed')
            },
            onRuleEnd: payload => events.push(`${payload.cache}:${payload.state}`),
          },
          runner: {
            cache: { location: cachePath },
          },
          setupConfig: createSetupConfig(),
        })
      }
      catch (error) {
        runError = error
      }

      expect(runError).toBeInstanceOf(AlintRunError)
      expect(runError).toMatchObject({
        failure: {
          message: 'diagnostic progress failed',
          ruleId: 'company/replay',
          target: {
            kind: 'function',
            name: 'load',
          },
        },
      })
      expect(events).toEqual([
        'hit:completed',
        'hit:errored',
      ])
    })
  })

  it('requires explicit filePath when reporting outside file context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-create-report-'))
    const filePath = join(root, 'demo.txt')

    await writeFile(filePath, 'hello\n')

    const rule = defineRule({
      create: (ctx) => {
        ctx.report({
          message: 'reported during create',
        })

        return {}
      },
    })

    await expect(runAlint({
      config: createConfig(
        { 'create-report': rule },
        { 'company/create-report': 'warn' },
        {},
        { language: 'text/plain' },
      ),
      files: [filePath],
      setupConfig: createSetupConfig(),
    })).rejects.toThrow('Diagnostic for rule "company/create-report" is missing filePath.')
  })

  it('surrounds directory and project rule progress with target progress', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-target-kind-progress-'))
    const directoryPath = join(root, 'crates', 'a')
    const events: string[] = []
    const rule = defineRule({
      create: () => ({
        onTargetDirectory: () => {},
        onTargetProject: () => {},
      }),
    })

    await runAlint({
      config: createConfig(
        { review: rule },
        { 'company/review': 'warn' },
      ),
      cwd: root,
      directories: [directoryPath],
      progress: {
        onRuleEnd: payload => events.push(`rule:end:${payload.path.target.kind}`),
        onRuleStart: payload => events.push(`rule:start:${payload.path.target.kind}`),
        onTargetEnd: payload => events.push(`target:end:${payload.path.target.kind}`),
        onTargetStart: payload => events.push(`target:start:${payload.path.target.kind}`),
      },
      setupConfig: createSetupConfig(),
    })

    expect(events).toEqual([
      'target:start:directory',
      'rule:start:directory',
      'rule:end:directory',
      'target:end:directory',
      'target:start:project',
      'rule:start:project',
      'rule:end:project',
      'target:end:project',
    ])
  })

  it('emits nested progress events in language target order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-progress-'))
    const filePath = join(root, 'demo.ts')
    const events: string[] = []

    await writeFile(filePath, [
      'export class Loader {}',
      'export function load() {',
      '  return 2',
      '}',
    ].join('\n'))

    const rule = defineRule({
      create: () => ({
        onTargetClass: () => {},
        onTargetFile: () => {},
        onTargetFunction: () => {},
      }),
    })

    await runAlint({
      config: createConfig({ 'visit-all': rule }, { 'company/visit-all': 'warn' }),
      files: [filePath],
      progress: {
        onFileEnd: payload => events.push(`file:end:${payload.file.path}`),
        onFileStart: payload => events.push(`file:start:${payload.file.path}:${payload.file.total}`),
        onRuleEnd: payload => events.push(`rule:end:${payload.path.target.kind}:${payload.path.rule.id}`),
        onRuleStart: payload => events.push(`rule:start:${payload.path.target.kind}:${payload.path.rule.id}`),
        onRunEnd: payload => events.push(`run:end:${payload.completed}/${payload.cached}/${payload.errored}/${payload.planned}`),
        onRunStart: payload => events.push(`run:start:${payload.filesTotal}:${payload.rulesTotal}:${payload.planned}`),
        onTargetEnd: payload => events.push(`target:end:${payload.path.target.kind}`),
        onTargetStart: payload => events.push(`target:start:${payload.path.target.kind}:${payload.path.target.total}`),
      },
      setupConfig: createSetupConfig(),
    })

    expect(events).toEqual([
      'run:start:1:1:3',
      `file:start:${filePath}:1`,
      'target:start:file:3',
      'rule:start:file:company/visit-all',
      'rule:end:file:company/visit-all',
      'target:end:file',
      'target:start:class:3',
      'rule:start:class:company/visit-all',
      'rule:end:class:company/visit-all',
      'target:end:class',
      'target:start:function:3',
      'rule:start:function:company/visit-all',
      'rule:end:function:company/visit-all',
      'target:end:function',
      `file:end:${filePath}`,
      'run:end:3/0/0/3',
    ])
  })

  it('emits progress in target rule order for multiple rules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-progress-file-first-'))
    const firstFilePath = join(root, 'a.ts')
    const secondFilePath = join(root, 'b.ts')
    const events: string[] = []

    await writeFile(firstFilePath, 'export function first() {}\n')
    await writeFile(secondFilePath, 'export function second() {}\n')

    const firstRule = defineRule({
      create: () => ({
        onTargetFile: () => {},
        onTargetFunction: () => {},
      }),
    })
    const secondRule = defineRule({
      create: () => ({
        onTargetFile: () => {},
        onTargetFunction: () => {},
      }),
    })

    await runAlint({
      config: createConfig(
        {
          first: firstRule,
          second: secondRule,
        },
        {
          'company/first': 'warn',
          'company/second': 'warn',
        },
      ),
      files: [firstFilePath, secondFilePath],
      progress: {
        onFileEnd: payload => events.push(`file:end:${payload.file.path}`),
        onFileStart: payload => events.push(`file:start:${payload.file.path}`),
        onRuleStart: payload => events.push([
          payload.path.file.path,
          payload.path.target.kind,
          payload.path.rule.id,
          `${payload.path.rule.index}/${payload.path.rule.total}`,
        ].join('|')),
        onRunEnd: payload => events.push(`run:end:${payload.completed}/${payload.planned}`),
        onRunStart: payload => events.push(`run:start:${payload.planned}`),
        onTargetEnd: payload => events.push(`${payload.path.file.path}|target:end:${payload.path.target.kind}`),
        onTargetStart: payload => events.push(`${payload.path.file.path}|target:start:${payload.path.target.kind}`),
      },
      setupConfig: createSetupConfig(),
    })

    expect(events).toEqual([
      'run:start:8',
      `file:start:${firstFilePath}`,
      `${firstFilePath}|target:start:file`,
      `${firstFilePath}|file|company/first|1/2`,
      `${firstFilePath}|file|company/second|2/2`,
      `${firstFilePath}|target:end:file`,
      `${firstFilePath}|target:start:function`,
      `${firstFilePath}|function|company/first|1/2`,
      `${firstFilePath}|function|company/second|2/2`,
      `${firstFilePath}|target:end:function`,
      `file:end:${firstFilePath}`,
      `file:start:${secondFilePath}`,
      `${secondFilePath}|target:start:file`,
      `${secondFilePath}|file|company/first|1/2`,
      `${secondFilePath}|file|company/second|2/2`,
      `${secondFilePath}|target:end:file`,
      `${secondFilePath}|target:start:function`,
      `${secondFilePath}|function|company/first|1/2`,
      `${secondFilePath}|function|company/second|2/2`,
      `${secondFilePath}|target:end:function`,
      `file:end:${secondFilePath}`,
      'run:end:8/8',
    ])
  })

  it('reports run start rulesTotal as enabled rule id union across files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-progress-rules-total-'))
    const firstFilePath = join(root, 'a.go')
    const secondFilePath = join(root, 'b.txt')
    const events: string[] = []

    await writeFile(firstFilePath, 'package main\n')
    await writeFile(secondFilePath, 'hello\n')

    const firstRule = defineRule({
      create: () => ({
        onTargetWith: () => {},
      }),
    })
    const secondRule = defineRule({
      create: () => ({
        onTargetWith: () => {},
      }),
    })

    await runAlint({
      config: defineConfig([
        {
          files: ['**/*.go'],
          language: 'text/plain',
          plugins: {
            first: definePlugin({
              rules: { check: firstRule },
            }),
          },
          rules: { 'first/check': 'warn' },
        },
        {
          files: ['**/*.txt'],
          language: 'text/plain',
          plugins: {
            second: definePlugin({
              rules: { check: secondRule },
            }),
          },
          rules: { 'second/check': 'warn' },
        },
      ]),
      cwd: root,
      files: [firstFilePath, secondFilePath],
      progress: {
        onRunStart: payload => events.push(`rules:${payload.rulesTotal}`),
      },
      setupConfig: createSetupConfig(),
    })

    expect(events).toEqual([
      'rules:2',
    ])
  })

  it('emits timing and per-file planned metadata in progress events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-progress-timing-'))
    const filePath = join(root, 'demo.txt')
    const events: Array<{
      endedAt?: number
      name: string
      planned?: number
      startedAt?: number
    }> = []

    await writeFile(filePath, 'hello\n')

    const rule = defineRule({
      create: () => ({
        onTargetFile: () => {},
      }),
    })

    await runAlint({
      config: createConfig(
        { timing: rule },
        { 'company/timing': 'warn' },
        {},
        { language: 'text/plain' },
      ),
      files: [filePath],
      progress: {
        onFileEnd: payload => events.push({
          endedAt: payload.endedAt,
          name: 'file:end',
          planned: payload.file.planned,
          startedAt: payload.startedAt,
        }),
        onFileStart: payload => events.push({
          name: 'file:start',
          planned: payload.file.planned,
          startedAt: payload.startedAt,
        }),
        onRuleEnd: payload => events.push({
          endedAt: payload.endedAt,
          name: 'rule:end',
          startedAt: payload.startedAt,
        }),
        onRuleStart: payload => events.push({
          name: 'rule:start',
          startedAt: payload.startedAt,
        }),
        onRunEnd: payload => events.push({
          endedAt: payload.endedAt,
          name: 'run:end',
          startedAt: payload.startedAt,
        }),
        onRunStart: payload => events.push({
          name: 'run:start',
          planned: payload.files?.[0]?.planned,
          startedAt: payload.startedAt,
        }),
      },
      setupConfig: createSetupConfig(),
    })

    expect(events.map(event => event.name)).toEqual([
      'run:start',
      'file:start',
      'rule:start',
      'rule:end',
      'file:end',
      'run:end',
    ])
    expect(events[0]).toMatchObject({ planned: 1, startedAt: expect.any(Number) })
    expect(events[1]).toMatchObject({ planned: 1, startedAt: expect.any(Number) })
    expect(events[2]).toMatchObject({ startedAt: expect.any(Number) })
    expect(events[3]).toMatchObject({ endedAt: expect.any(Number), startedAt: events[2]?.startedAt })
    expect(events[4]).toMatchObject({ endedAt: expect.any(Number), planned: 1, startedAt: events[1]?.startedAt })
    expect(events[5]).toMatchObject({ endedAt: expect.any(Number), startedAt: events[0]?.startedAt })
  })

  it('runs files concurrently when file concurrency is greater than one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-concurrent-files-'))
    const firstFilePath = join(root, 'a.txt')
    const secondFilePath = join(root, 'b.txt')
    const events: string[] = []
    let resolveSecondStarted!: () => void
    const secondStarted = new Promise<void>((resolve) => {
      resolveSecondStarted = resolve
    })

    await writeFile(firstFilePath, 'first\n')
    await writeFile(secondFilePath, 'second\n')

    const rule = defineRule({
      create: () => ({
        onTargetFile: async (target) => {
          events.push(`start:${target.file.path}`)

          if (target.file.path === firstFilePath) {
            await secondStarted
          }
          else {
            resolveSecondStarted()
          }

          events.push(`end:${target.file.path}`)
        },
      }),
    })

    await runAlint({
      config: createConfig(
        { concurrent: rule },
        { 'company/concurrent': 'warn' },
        {},
        { language: 'text/plain' },
      ),
      files: [firstFilePath, secondFilePath],
      runner: {
        fileConcurrency: 2,
      },
      setupConfig: createSetupConfig(),
    })

    expect(events.slice(0, 2)).toEqual([
      `start:${firstFilePath}`,
      `start:${secondFilePath}`,
    ])
    expect(events).toContain(`end:${firstFilePath}`)
    expect(events).toContain(`end:${secondFilePath}`)
  })

  it('keeps execution state isolated between concurrent files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-concurrent-state-'))
    const firstFilePath = join(root, 'a.txt')
    const secondFilePath = join(root, 'b.txt')
    let resolveFirstModelReady!: () => void
    let resolveSecondReported!: () => void
    const firstModelReady = new Promise<void>((resolve) => {
      resolveFirstModelReady = resolve
    })
    const secondReported = new Promise<void>((resolve) => {
      resolveSecondReported = resolve
    })

    await writeFile(firstFilePath, 'first\n')
    await writeFile(secondFilePath, 'second\n')

    const rule = defineRule({
      create: ctx => ({
        onTargetFile: async (target) => {
          if (target.file.path === firstFilePath) {
            const model = await ctx.model('default')
            resolveFirstModelReady()
            await secondReported
            ctx.report({
              message: `first ${model.id}`,
            })
            return
          }

          await firstModelReady

          const model = await ctx.model('override')

          ctx.report({
            message: `second ${model.id}`,
          })
          resolveSecondReported()
        },
      }),
      model: {
        capabilities: ['structured-output'],
      },
    })

    const result = await runAlint({
      config: createConfig(
        { isolated: rule },
        { 'company/isolated': 'warn' },
        {},
        { language: 'text/plain' },
      ),
      files: [firstFilePath, secondFilePath],
      runner: {
        fileConcurrency: 2,
      },
      setupConfig: createSetupConfig(),
    })

    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: firstFilePath,
        message: 'first local:qwen-8b',
        model: expect.objectContaining({
          resolvedId: 'local:qwen-8b',
        }),
      }),
      expect.objectContaining({
        filePath: secondFilePath,
        message: 'second local:qwen-32b',
        model: expect.objectContaining({
          resolvedId: 'local:qwen-32b',
        }),
      }),
    ]))
  })

  it('emits diagnostic progress when rules report findings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-progress-diagnostic-'))
    const filePath = join(root, 'demo.txt')
    const events: string[] = []

    await writeFile(filePath, 'hello\n')

    const rule = defineRule({
      create: ctx => ({
        onTargetFile: (target) => {
          ctx.report({
            filePath: target.file.path,
            message: 'Problem found',
          })
        },
      }),
    })

    await runAlint({
      config: createConfig(
        { diagnostic: rule },
        { 'company/diagnostic': 'warn' },
        {},
        { language: 'text/plain' },
      ),
      files: [filePath],
      progress: {
        onDiagnostic: payload => events.push(`${payload.diagnostic.message}:${payload.diagnostics.length}:${payload.path?.target.kind}`),
      },
      setupConfig: createSetupConfig(),
    })

    expect(events).toEqual([
      'Problem found:1:file',
    ])
  })

  it('emits usage progress with the current rule path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-progress-usage-'))
    const filePath = join(root, 'demo.ts')
    const usageEvents: string[] = []

    await writeFile(filePath, 'export function load() {}\n')

    const rule = defineRule({
      create: ctx => ({
        onTargetFunction: (target) => {
          ctx.metering.recordUsage({
            filePath: target.file.path,
            inputTokens: 4,
            modelId: 'local:qwen-8b',
            outputTokens: 2,
            providerId: 'ollama',
            totalTokens: 6,
          })
        },
      }),
    })

    await runAlint({
      config: createConfig({ 'record-usage': rule }, { 'company/record-usage': 'warn' }),
      files: [filePath],
      progress: {
        onUsage: payload => usageEvents.push([
          payload.path?.file.path,
          payload.path?.target.kind,
          payload.path?.rule.id,
          payload.total.totalTokens,
        ].join(':')),
      },
      setupConfig: createSetupConfig(),
    })

    expect(usageEvents).toEqual([
      `${filePath}:function:company/record-usage:6`,
    ])
  })

  it('emits errored rule progress before rethrowing rule failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-progress-error-'))
    const filePath = join(root, 'demo.txt')
    const events: string[] = []

    await writeFile(filePath, 'hello\n')

    const rule = defineRule({
      create: () => ({
        onTargetFile: () => {
          throw new Error('rule exploded')
        },
      }),
    })

    await expect(runAlint({
      config: createConfig(
        { explode: rule },
        { 'company/explode': 'warn' },
        {},
        { language: 'text/plain' },
      ),
      files: [filePath],
      progress: {
        onRuleEnd: payload => events.push(`${payload.state}:${payload.path.rule.id}`),
        onRunEnd: payload => events.push(`run:${payload.completed}/${payload.errored}/${payload.planned}`),
      },
      setupConfig: createSetupConfig(),
    })).rejects.toThrow('rule exploded')

    expect(events).toEqual([
      'errored:company/explode',
      'run:0/1/1',
    ])
  })

  it('does not mark handlers errored when completed progress callbacks throw', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-progress-callback-success-'))
    const filePath = join(root, 'demo.txt')
    const events: string[] = []

    await writeFile(filePath, 'hello\n')

    const rule = defineRule({
      create: () => ({
        onTargetFile: () => {},
      }),
    })

    await expect(runAlint({
      config: createConfig(
        { 'callback-success': rule },
        { 'company/callback-success': 'warn' },
        {},
        { language: 'text/plain' },
      ),
      files: [filePath],
      progress: {
        onRuleEnd: () => {
          throw new Error('progress exploded')
        },
        onRunEnd: payload => events.push(`run:${payload.completed}/${payload.errored}/${payload.planned}`),
      },
      setupConfig: createSetupConfig(),
    })).rejects.toThrow('progress exploded')

    expect(events).toEqual([
      'run:1/0/1',
    ])
  })

  it('preserves rule failures when errored progress callbacks throw', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-progress-callback-error-'))
    const filePath = join(root, 'demo.txt')
    const events: string[] = []

    await writeFile(filePath, 'hello\n')

    const rule = defineRule({
      create: () => ({
        onTargetFile: () => {
          throw new Error('rule exploded')
        },
      }),
    })

    await expect(runAlint({
      config: createConfig(
        { 'callback-error': rule },
        { 'company/callback-error': 'warn' },
        {},
        { language: 'text/plain' },
      ),
      files: [filePath],
      progress: {
        onRuleEnd: () => {
          throw new Error('progress exploded')
        },
        onRunEnd: payload => events.push(`run:${payload.completed}/${payload.errored}/${payload.planned}`),
      },
      setupConfig: createSetupConfig(),
    })).rejects.toThrow('rule exploded')

    expect(events).toEqual([
      'run:0/1/1',
    ])
  })

  it('preserves rule failures when cleanup progress callbacks throw', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-progress-cleanup-error-'))
    const filePath = join(root, 'demo.txt')
    const events: string[] = []

    await writeFile(filePath, 'hello\n')

    const rule = defineRule({
      create: () => ({
        onTargetFile: () => {
          throw new Error('rule exploded')
        },
      }),
    })

    await expect(runAlint({
      config: createConfig(
        { cleanup: rule },
        { 'company/cleanup': 'warn' },
        {},
        { language: 'text/plain' },
      ),
      files: [filePath],
      progress: {
        onFileEnd: () => {
          throw new Error('file progress exploded')
        },
        onRunEnd: (payload) => {
          events.push(`run:${payload.completed}/${payload.errored}/${payload.planned}`)
          throw new Error('run progress exploded')
        },
      },
      setupConfig: createSetupConfig(),
    })).rejects.toThrow('rule exploded')

    expect(events).toEqual([
      'run:0/1/1',
    ])
  })

  describe('cacheOnly', () => {
    const reportingRule = () => defineRule({
      create: ctx => ({
        onTargetFunction: (target) => {
          ctx.report({ message: `checked ${target.name}` })
          ctx.metering.recordUsage({
            filePath: target.file.path,
            inputTokens: 7,
            modelId: 'local:qwen-8b',
            outputTokens: 3,
            providerId: 'ollama',
            totalTokens: 10,
          })
        },
      }),
    })

    it('skips rules that miss cache instead of executing them', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-cache-only-miss-'))
      const filePath = join(root, 'demo.ts')
      const ruleEndEvents: string[] = []
      let handlerCalls = 0

      await writeFile(filePath, 'export function load() {}\n')

      const rule = defineRule({
        create: ctx => ({
          onTargetFunction: (target) => {
            handlerCalls += 1
            ctx.report({ message: `checked ${target.name}` })
          },
        }),
      })

      const result = await runAlint({
        cacheOnly: true,
        config: createConfig({ review: rule }, { 'company/review': 'warn' }),
        cwd: root,
        files: [filePath],
        progress: {
          onRuleEnd: payload => ruleEndEvents.push(`${payload.cache}:${payload.state}`),
        },
        setupConfig: createSetupConfig(),
      })

      expect(handlerCalls).toBe(0)
      expect(result.diagnostics).toEqual([])
      expect(result.execution).toEqual({
        cached: 0,
        completed: 0,
        errored: 0,
        planned: 1,
        skipped: 1,
      })
      expect(ruleEndEvents).toEqual(['miss:skipped'])
    })

    it('replays cached diagnostics and usage without running the rule again', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-cache-only-hit-'))
      const filePath = join(root, 'demo.ts')
      const cachePath = join(root, '.alintcache')
      const ruleEndEvents: string[] = []
      let handlerCalls = 0

      await writeFile(filePath, 'export function load() {}\n')

      const rule = defineRule({
        create: ctx => ({
          onTargetFunction: (target) => {
            handlerCalls += 1
            ctx.report({ message: `checked ${target.name}` })
            ctx.metering.recordUsage({
              filePath: target.file.path,
              inputTokens: 7,
              modelId: 'local:qwen-8b',
              outputTokens: 3,
              providerId: 'ollama',
              totalTokens: 10,
            })
          },
        }),
      })
      const config = createConfig({ review: rule }, { 'company/review': 'warn' })

      await runAlint({
        config,
        cwd: root,
        files: [filePath],
        runner: { cache: { location: cachePath } },
        setupConfig: createSetupConfig(),
      })

      const result = await runAlint({
        cacheOnly: true,
        config,
        cwd: root,
        files: [filePath],
        progress: {
          onRuleEnd: payload => ruleEndEvents.push(`${payload.cache}:${payload.state}`),
        },
        runner: { cache: { location: cachePath } },
        setupConfig: createSetupConfig(),
      })

      expect(handlerCalls).toBe(1)
      expect(result.diagnostics).toMatchObject([
        {
          cached: true,
          filePath,
          message: 'checked load',
          ruleId: 'company/review',
        },
      ])
      expect(result.usage.cached?.totalTokens).toBe(10)
      expect(result.usage.totalTokens).toBe(0)
      expect(result.execution).toEqual({
        cached: 1,
        completed: 0,
        errored: 0,
        planned: 1,
        skipped: 0,
      })
      expect(ruleEndEvents).toEqual(['hit:completed'])
    })

    it('reports cached findings while counting the rules that still need a paid run', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-cache-only-mixed-'))
      const filePath = join(root, 'demo.ts')
      const cachePath = join(root, '.alintcache')
      const ruleEndEvents: string[] = []
      const calls = { first: 0, second: 0 }

      await writeFile(filePath, 'export function load() {}\n')

      const firstRule = defineRule({
        create: ctx => ({
          onTargetFunction: (target) => {
            calls.first += 1
            ctx.report({ message: `first checked ${target.name}` })
          },
        }),
      })
      const secondRule = defineRule({
        create: ctx => ({
          onTargetFunction: (target) => {
            calls.second += 1
            ctx.report({ message: `second checked ${target.name}` })
          },
        }),
      })
      const rules = { first: firstRule, second: secondRule }

      await runAlint({
        config: createConfig(rules, { 'company/first': 'warn' }),
        cwd: root,
        files: [filePath],
        runner: { cache: { location: cachePath } },
        setupConfig: createSetupConfig(),
      })

      const result = await runAlint({
        cacheOnly: true,
        config: createConfig(rules, { 'company/first': 'warn', 'company/second': 'warn' }),
        cwd: root,
        files: [filePath],
        progress: {
          onRuleEnd: payload => ruleEndEvents.push(`${payload.path.rule.id}:${payload.cache}:${payload.state}`),
        },
        runner: { cache: { location: cachePath } },
        setupConfig: createSetupConfig(),
      })

      expect(calls).toEqual({ first: 1, second: 0 })
      expect(result.diagnostics).toMatchObject([
        { message: 'first checked load', ruleId: 'company/first' },
      ])
      expect(result.execution).toEqual({
        cached: 1,
        completed: 0,
        errored: 0,
        planned: 2,
        skipped: 1,
      })
      expect(ruleEndEvents).toEqual([
        'company/first:hit:completed',
        'company/second:miss:skipped',
      ])
    })

    it('skips rules that opt out of caching, since they can never be served from cache', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-cache-only-opt-out-'))
      const filePath = join(root, 'demo.ts')
      const ruleEndEvents: string[] = []
      let handlerCalls = 0

      await writeFile(filePath, 'export function load() {}\n')

      const rule = defineRule({
        cache: false,
        create: () => ({
          onTargetFunction: () => {
            handlerCalls += 1
          },
        }),
      })

      const result = await runAlint({
        cacheOnly: true,
        config: createConfig({ uncached: rule }, { 'company/uncached': 'warn' }),
        cwd: root,
        files: [filePath],
        progress: {
          onRuleEnd: payload => ruleEndEvents.push(`${payload.cache}:${payload.state}`),
        },
        setupConfig: createSetupConfig(),
      })

      expect(handlerCalls).toBe(0)
      expect(result.execution).toMatchObject({ skipped: 1 })
      expect(ruleEndEvents).toEqual(['miss:skipped'])
    })

    it('leaves an existing cache file untouched even when the source changed under it', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-cache-only-no-write-'))
      const filePath = join(root, 'demo.ts')
      const cachePath = join(root, '.alintcache')
      const config = createConfig({ review: reportingRule() }, { 'company/review': 'warn' })

      await writeFile(filePath, 'export function load() {}\n')
      await runAlint({
        config,
        cwd: root,
        files: [filePath],
        runner: { cache: { location: cachePath } },
        setupConfig: createSetupConfig(),
      })

      const warmed = await readFile(cachePath, 'utf8')

      // Editing the source makes the target miss, so a reconciling run would rewrite both the
      // file's content hash and its entry list. A cacheOnly run must not touch either.
      await writeFile(filePath, 'export function load() {\n  return 1\n}\n')

      const result = await runAlint({
        cacheOnly: true,
        config,
        cwd: root,
        files: [filePath],
        runner: { cache: { location: cachePath } },
        setupConfig: createSetupConfig(),
      })

      expect(result.execution).toMatchObject({ cached: 0, skipped: 1 })
      expect(await readFile(cachePath, 'utf8')).toBe(warmed)
    })

    it('does not create a cache file when none exists yet', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-cache-only-no-create-'))
      const filePath = join(root, 'demo.ts')

      await writeFile(filePath, 'export function load() {}\n')

      await runAlint({
        cacheOnly: true,
        config: createConfig({ review: reportingRule() }, { 'company/review': 'warn' }),
        cwd: root,
        files: [filePath],
        setupConfig: createSetupConfig(),
      })

      await expect(access(join(root, '.alintcache'))).rejects.toThrow()
    })
  })
})
