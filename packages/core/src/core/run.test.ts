import type { AgentAdapter } from '../agent/types'
import type { RunnerConfig, SetupConfig } from '../config/types'
import type { PluginDefinition, ProjectTarget, RuleConfigEntry, RuleContext, RuleDefinition } from '../dsl/types'
import type { ProgressJob } from '../index'

import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { number, object, optional } from 'valibot'
import { describe, expect, it, vi } from 'vitest'

import { requireAgent, RetryableAgentError } from '../agent'
import { defineConfig, definePlugin, defineRule } from '../dsl/define'
import { readCacheBody } from './cache'
import { AlintAbortError, AlintRunCancelledError, AlintRunError, runAlint } from './run'

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

  it('validates rule timeout before planning an empty run', async () => {
    await expect(runAlint({ runner: { timeoutMs: 0 } }))
      .rejects
      .toThrow(new TypeError('Rule execution timeout must be a finite positive integer.'))
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid rule concurrency %s before planning a zero-job run',
    async (ruleConcurrency) => {
      const events: string[] = []

      await expect(runAlint({
        progress: {
          onRunEnd: () => events.push('end'),
          onRunStart: () => events.push('start'),
        },
        runner: { ruleConcurrency },
        setupConfig: createSetupConfig(),
      })).rejects.toThrow(new TypeError('Rule execution concurrency must be a finite positive integer.'))

      expect(events).toEqual([])
    },
  )

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

  it('queues every job before starting jobs and emits each job lifecycle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-job-progress-'))
    const filePath = join(root, 'demo.txt')
    const events: string[] = []
    const jobs: ProgressJob[] = []

    await writeFile(filePath, 'hello\n')

    const firstRule = defineRule({
      create: () => ({
        onTargetFile: () => {},
      }),
    })
    const secondRule = defineRule({
      create: () => ({
        onTargetFile: () => {},
      }),
    })

    await runAlint({
      config: createConfig(
        { first: firstRule, second: secondRule },
        { 'company/first': 'warn', 'company/second': 'warn' },
        {},
        { language: 'text/plain' },
      ),
      cwd: root,
      files: [filePath],
      progress: {
        onJobEnd: ({ job, state }) => events.push(`end:${job.index}:${state}`),
        onJobQueued: ({ job }) => {
          jobs.push(job)
          events.push(`queued:${job.index}`)
        },
        onJobStart: ({ job }) => events.push(`start:${job.index}`),
      },
      setupConfig: createSetupConfig(),
    })

    expect(jobs).toEqual([
      {
        id: expect.any(String),
        index: 1,
        inputPath: filePath,
        ruleId: 'company/first',
        ruleIndex: 1,
        ruleTotal: 1,
        target: {
          identity: 'file:demo.txt',
          kind: 'file',
        },
        total: 2,
      },
      {
        id: expect.any(String),
        index: 2,
        inputPath: filePath,
        ruleId: 'company/second',
        ruleIndex: 1,
        ruleTotal: 1,
        target: {
          identity: 'file:demo.txt',
          kind: 'file',
        },
        total: 2,
      },
    ])
    expect(events.slice(0, 2)).toEqual(['queued:1', 'queued:2'])
    expect(events).toEqual([
      'queued:1',
      'queued:2',
      'start:1',
      'start:2',
      'end:1:completed',
      'end:2:completed',
    ])
  })

  it('emits rule-level progress metadata on queued jobs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-rule-progress-metadata-'))
    const firstPath = join(root, 'first.txt')
    const secondPath = join(root, 'second.txt')
    const jobs: Array<{ index: number, ruleId: string, ruleIndex: number, ruleTotal: number, total: number }> = []

    await writeFile(firstPath, 'first\n')
    await writeFile(secondPath, 'second\n')

    const one = defineRule({ create: () => ({ onTargetFile: () => {} }) })
    const two = defineRule({ create: () => ({ onTargetFile: () => {} }) })

    await runAlint({
      config: createConfig(
        { one, two },
        { 'company/one': 'warn', 'company/two': 'warn' },
        {},
        { language: 'text/plain' },
      ),
      files: [firstPath, secondPath],
      progress: {
        onJobQueued: ({ job }) => jobs.push({
          index: job.index,
          ruleId: job.ruleId,
          ruleIndex: job.ruleIndex,
          ruleTotal: job.ruleTotal,
          total: job.total,
        }),
      },
      setupConfig: createSetupConfig(),
    })

    expect(jobs).toEqual([
      { index: 1, ruleId: 'company/one', ruleIndex: 1, ruleTotal: 2, total: 4 },
      { index: 2, ruleId: 'company/two', ruleIndex: 1, ruleTotal: 2, total: 4 },
      { index: 3, ruleId: 'company/one', ruleIndex: 2, ruleTotal: 2, total: 4 },
      { index: 4, ruleId: 'company/two', ruleIndex: 2, ruleTotal: 2, total: 4 },
    ])
  })

  it('assigns unique job IDs to repeated inputs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-repeated-job-id-'))
    const filePath = join(root, 'demo.txt')
    const jobs: ProgressJob[] = []
    await writeFile(filePath, 'hello\n')
    const rule = defineRule({
      create: () => ({
        onTargetFile: () => {},
      }),
    })

    await runAlint({
      config: createConfig({ review: rule }, { 'company/review': 'warn' }, {}, { language: 'text/plain' }),
      cwd: root,
      files: [filePath, filePath],
      progress: { onJobQueued: ({ job }) => jobs.push(job) },
      runner: { cache: false },
      setupConfig: createSetupConfig(),
    })

    expect(jobs.map(job => job.index)).toEqual([1, 2])
    expect(new Set(jobs.map(job => job.id)).size).toBe(2)
  })

  it('exposes the run signal only through the active rule execution context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-rule-signal-'))
    const filePath = join(root, 'demo.txt')
    const controller = new AbortController()
    const observed: Array<AbortSignal | undefined> = []

    await writeFile(filePath, 'hello\n')

    const rule = defineRule({
      create: (ctx) => {
        observed.push(ctx.signal)

        return {
          onTargetFile: () => {
            observed.push(ctx.signal)
          },
        }
      },
    })

    await runAlint({
      config: createConfig(
        { review: rule },
        { 'company/review': 'warn' },
        {},
        { language: 'text/plain' },
      ),
      cwd: root,
      files: [filePath],
      setupConfig: createSetupConfig(),
      signal: controller.signal,
    })

    expect(observed[0]).toBeUndefined()
    expect(observed[1]).toBeUndefined()
    expect(observed[2]).toBeInstanceOf(AbortSignal)
    expect(observed[2]).not.toBe(controller.signal)
    expect(observed[2]?.aborted).toBe(false)
  })

  it('passes parsed rule options to rule contexts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-rule-options-'))
    await writeFile(join(root, 'source.txt'), 'hello\n', 'utf8')
    const observedOptions: unknown[] = []
    const rule = defineRule({
      create: (context) => {
        observedOptions.push(...context.options)

        return {
          onTargetFile: () => {},
        }
      },
      options: [
        object({
          maxLines: optional(number(), 10),
        }),
      ],
    })

    await runAlint({
      config: defineConfig([
        {
          files: ['source.txt'],
          plugins: {
            company: definePlugin({
              rules: {
                review: rule,
              },
            }),
          },
          rules: {
            'company/review': ['warn', {}],
          },
        },
      ]),
      cwd: root,
      files: ['source.txt'],
    })

    expect(observedOptions).toEqual([{ maxLines: 10 }])
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

    const cacheFile = await readCacheBody(join(root, '.alintcache'))
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
          onJobEnd: payload => ruleEndEvents.push(`${payload.job.target.kind}:${payload.cache}`),
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
          onRunEnd: payload => runEndEvents.push(`${payload.diagnostics.length}:${payload.execution.failed}/${payload.execution.planned}`),
        },
        setupConfig: createSetupConfig(),
      })
    }
    catch (error) {
      runError = error
    }

    expect(runError).toBeInstanceOf(AlintRunError)
    expect(runError).toMatchObject({
      failures: [{
        job: {
          inputPath: directoryPath,
          ruleId: 'company/review',
          target: { kind: 'directory' },
        },
        kind: 'handler',
        message: 'directory exploded',
      }],
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

    const cacheFile = await readCacheBody(join(root, '.alintcache'))

    expect(Object.keys(cacheFile.entries)).toHaveLength(1)
    expect(Object.values(cacheFile.entries)[0]?.target.kind).toBe('project')
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

    const cacheFile = await readCacheBody(join(root, '.alintcache'))
    const projectEntryKeys = Object.entries(cacheFile.entries)
      .filter(([, entry]) => entry.target.kind === 'project')
      .map(([key]) => key)

    expect(projectEntryKeys).toHaveLength(1)
    expect(Object.values(cacheFile.owners).find(owner => owner.kind === 'project')).toEqual(
      expect.objectContaining({ path: '.', slots: projectEntryKeys }),
    )
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
        onJobEnd: payload => ruleEndEvents.push(`${payload.job.target.kind}:${payload.cache}`),
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
        onJobEnd: payload => ruleEndEvents.push(`${payload.job.target.kind}:${payload.cache}`),
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
      failures: [{ message: 'Diagnostic for rule "company/review" is missing filePath.' }],
      message: '1 rule execution failed.',
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
          onRunEnd: payload => runEndEvents.push(`${payload.diagnostics.length}:${payload.execution.failed}/${payload.execution.planned}`),
        },
        setupConfig: createSetupConfig(),
      })
    }
    catch (error) {
      runError = error
    }

    expect(runError).toBeInstanceOf(AlintRunError)
    expect(runError).toMatchObject({
      failures: [{
        job: {
          inputPath: root,
          ruleId: 'company/review',
          target: { kind: 'project' },
        },
        kind: 'handler',
        message: 'project exploded',
      }],
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

  it('emits job retry progress for retryable configured agent failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-job-retry-progress-'))
    const filePath = join(root, 'demo.txt')
    const events: string[] = []
    let calls = 0

    await writeFile(filePath, 'hello\n')

    const rule = defineRule({
      create: ctx => ({
        onTargetFile: async () => {
          await ctx.agent!({
            instructions: 'review',
            model: await ctx.model(),
            prompt: 'review',
            tools: [],
          })
        },
      }),
    })

    await runAlint({
      config: createConfig(
        { review: rule },
        { 'company/review': 'warn' },
        {},
        {
          agent: async () => {
            calls += 1
            if (calls < 3)
              throw new RetryableAgentError(`retry ${calls}`)
            return { answer: 'ok' }
          },
          language: 'text/plain',
        },
      ),
      files: [filePath],
      progress: {
        onJobRetry: payload => events.push(`${payload.job.ruleId}:${payload.attempt}/${payload.maxAttempts}`),
      },
      setupConfig: createSetupConfig(),
    })

    expect(events).toEqual([
      'company/review:1/3',
      'company/review:2/3',
    ])
  })

  it('propagates a retry progress reporter exception raised during a handler', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-job-retry-progress-failure-'))
    const filePath = join(root, 'demo.txt')
    const sentinel = new Error('retry reporter failed')
    let calls = 0

    await writeFile(filePath, 'hello\n')

    const rule = defineRule({
      create: ctx => ({
        onTargetFile: async () => {
          await ctx.agent!({
            instructions: 'review',
            model: await ctx.model(),
            prompt: 'review',
            tools: [],
          })
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
          {
            agent: async () => {
              calls += 1
              if (calls === 1)
                throw new RetryableAgentError('retry once')
              return { answer: 'ok' }
            },
            language: 'text/plain',
          },
        ),
        files: [filePath],
        progress: { onJobRetry: () => { throw sentinel } },
        setupConfig: createSetupConfig(),
      })
    }
    catch (error) {
      runError = error
    }

    expect(runError).toBe(sentinel)
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
  })

  it('does not retry a retryable configured agent when agent retries are zero', async () => {
    let calls = 0

    await expect(runSingleAgentRule({
      adapter: async () => {
        calls += 1
        throw new RetryableAgentError('retry disabled')
      },
      runner: { agentRetries: 0 },
    })).rejects.toBeInstanceOf(AlintRunError)

    expect(calls).toBe(1)
  })

  it('ignores unused agent retry values when no adapter is configured', async () => {
    await expect(runAlint({
      config: [],
      runner: { agentRetries: -1 },
      setupConfig: createSetupConfig(),
    })).resolves.toMatchObject({ diagnostics: [] })
  })

  it('combines the rule timeout signal with an agent request signal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-agent-signal-'))
    const filePath = join(root, 'demo.txt')
    const requestController = new AbortController()
    let observedRuleSignal: AbortSignal | undefined
    let observedAgentSignal: AbortSignal | undefined

    await writeFile(filePath, 'hello\n')

    const adapter = async (request: Parameters<NonNullable<RuleContext['agent']>>[0]) => {
      observedAgentSignal = request.signal

      await new Promise<void>((resolve) => {
        const fallback = setTimeout(resolve, 50)
        request.signal?.addEventListener('abort', () => {
          clearTimeout(fallback)
          resolve()
        }, { once: true })
      })

      return { answer: 'done' }
    }
    const rule = defineRule({
      create: ctx => ({
        onTargetFile: async (target) => {
          observedRuleSignal = ctx.signal
          await requireAgent(ctx)({
            instructions: 'review',
            model: await ctx.model('default'),
            prompt: target.text,
            signal: requestController.signal,
            tools: [],
          })
        },
      }),
    })

    let runError: unknown
    try {
      await runAlint({
        config: createConfig(
          { boundary: rule },
          { 'company/boundary': 'warn' },
          {},
          { agent: adapter, files: ['**/*.txt'], language: 'text/plain' },
        ),
        cwd: root,
        files: [filePath],
        runner: { cache: false, timeoutMs: 5 },
        setupConfig: createSetupConfig(),
      })
    }
    catch (error) {
      runError = error
    }

    expect(runError).toBeInstanceOf(AlintRunError)
    expect((runError as AlintRunError).failures[0]?.kind).toBe('timeout')
    expect(observedRuleSignal?.aborted).toBe(true)
    expect(observedAgentSignal?.aborted).toBe(true)
    expect(requestController.signal.aborted).toBe(false)
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
    })).rejects.toMatchObject({
      failures: [{ message: expect.stringMatching(/requires an agent/i) }],
    })
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
          onJobEnd: payload => ruleEndEvents.push(`${payload.job.ruleId}:${payload.cache}`),
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
        cancelled: 0,
        completed: 1,
        failed: 0,
        planned: 2,
        queued: 0,
        running: 0,
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
          onJobEnd: payload => ruleEndEvents.push(payload.cache),
        },
        runner: { cache: { location: cachePath } },
        setupConfig: createSetupConfig(),
      })
      const cacheBody = await readCacheBody(cachePath)

      expect(handlerCalls).toBe(2)
      expect(ruleEndEvents).toEqual(['miss'])
      expect(Object.values(cacheBody.owners)[0]?.slots).toHaveLength(1)
      expect(Object.keys(cacheBody.entries)).toHaveLength(1)
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
          onDiagnostic: payload => diagnosticEvents.push(`${payload.diagnostic.message}:${payload.job.target.kind}`),
          onJobEnd: payload => ruleEndEvents.push(`${payload.job.target.kind}:${payload.cache}:${payload.state}`),
          onUsage: payload => usageEvents.push(`${payload.record.totalTokens}:${payload.job.target.kind}`),
        },
        runner: {
          cache: { location: cachePath },
        },
        setupConfig: createSetupConfig(),
      })
      const cacheBody = await readCacheBody(cachePath)

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
        cancelled: 0,
        completed: 0,
        failed: 0,
        planned: 1,
        queued: 0,
        running: 0,
        skipped: 0,
      })
      expect(diagnosticEvents).toEqual([
        'checked load:function',
      ])
      expect(usageEvents).toEqual([
        '10:function',
      ])
      expect(ruleEndEvents).toEqual([
        'function:hit:cached',
      ])
      expect(Object.values(cacheBody.owners)[0]?.slots).toHaveLength(1)
      expect(Object.keys(cacheBody.entries)).toHaveLength(1)
    })

    it('cancels after rule start without replaying a warm cache entry', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-cache-rule-start-cancel-'))
      const filePath = join(root, 'demo.txt')
      const cachePath = join(root, '.alintcache')
      const controller = new AbortController()
      const reason = new Error('cancelled from rule start')
      const ruleEnds: string[] = []
      let handlerCalls = 0
      await writeFile(filePath, 'hello\n')
      const rule = defineRule({
        create: ctx => ({
          onTargetFile: () => {
            handlerCalls += 1
            ctx.report({ message: 'cached diagnostic' })
            ctx.metering.recordUsage({
              inputTokens: 3,
              modelId: 'cached-model',
              providerId: 'cached-provider',
              totalTokens: 3,
            })
          },
        }),
      })
      const config = createConfig(
        { cancel: rule },
        { 'company/cancel': 'warn' },
        {},
        { language: 'text/plain' },
      )

      await runAlint({
        config,
        files: [filePath],
        runner: { cache: { location: cachePath } },
        setupConfig: createSetupConfig(),
      })

      let runError: unknown
      try {
        await runAlint({
          config,
          files: [filePath],
          progress: {
            onJobEnd: payload => ruleEnds.push(`${payload.cache}:${payload.state}`),
            onJobStart: () => controller.abort(reason),
          },
          runner: { cache: { location: cachePath } },
          setupConfig: createSetupConfig(),
          signal: controller.signal,
        })
      }
      catch (error) {
        runError = error
      }

      expect(runError).toBeInstanceOf(AlintRunCancelledError)
      expect((runError as AlintRunCancelledError).cause).toBe(reason)
      expect((runError as AlintRunCancelledError).result).toEqual({
        diagnostics: [],
        execution: {
          cached: 0,
          cancelled: 1,
          completed: 0,
          failed: 0,
          planned: 1,
          queued: 0,
          running: 0,
          skipped: 0,
        },
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          records: [],
          totalTokens: 0,
        },
      })
      expect(handlerCalls).toBe(1)
      expect(ruleEnds).toEqual(['miss:cancelled'])

      const retained = await readCacheBody(cachePath)
      expect(Object.values(retained.owners)[0]?.slots).toHaveLength(1)
      expect(Object.keys(retained.entries)).toHaveLength(1)

      const replayed = await runAlint({
        config,
        files: [filePath],
        runner: { cache: { location: cachePath } },
        setupConfig: createSetupConfig(),
      })

      expect(handlerCalls).toBe(1)
      expect(replayed.execution.cached).toBe(1)
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
          onJobEnd: payload => ruleEndEvents.push(`${payload.job.target.name ?? payload.job.target.kind}:${payload.cache}`),
        },
        runner: {
          cache: { location: cachePath },
        },
        setupConfig: createSetupConfig(),
      })
      const cacheBody = await readCacheBody(cachePath)

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
      expect(Object.values(cacheBody.owners)[0]?.slots).toHaveLength(2)
      expect(Object.keys(cacheBody.entries)).toHaveLength(2)
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
          onJobEnd: payload => ruleEndEvents.push(`${payload.job.target.kind}:${payload.cache}`),
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
          onJobEnd: payload => ruleEndEvents.push(payload.cache),
        },
        runner: {
          cache: { location: cachePath },
        },
        setupConfig: createSetupConfig(),
      })
      const cacheBody = await readCacheBody(cachePath)

      expect(result.diagnostics[0]?.message).toBe('second')
      expect(ruleEndEvents).toEqual([
        'miss',
      ])
      expect(Object.values(cacheBody.owners)[0]?.slots).toHaveLength(1)
      expect(Object.keys(cacheBody.entries)).toHaveLength(1)
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
          onJobEnd: payload => ruleEndEvents.push(payload.cache),
        },
        runner: {
          cache: { location: cachePath },
        },
        setupConfig: createSetupConfig(),
      })
      const cacheBody = await readCacheBody(cachePath)

      expect(calls).toBe(2)
      expect(result.diagnostics[0]?.message).toBe('checked in 日本語')
      expect(ruleEndEvents).toEqual([
        'miss',
      ])
      expect(Object.values(cacheBody.owners)[0]?.slots).toHaveLength(1)
      expect(Object.keys(cacheBody.entries)).toHaveLength(1)
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
          onJobEnd: payload => ruleEndEvents.push(payload.cache),
        },
        runner: {
          cache: { location: cachePath },
        },
        setupConfig: createSetupConfig(),
      })
      const cacheBody = await readCacheBody(cachePath)

      expect(result.diagnostics[0]?.message).toBe('custom/second')
      expect(ruleEndEvents).toEqual([
        'miss',
      ])
      expect(Object.values(cacheBody.owners)[0]?.slots).toHaveLength(1)
      expect(Object.keys(cacheBody.entries)).toHaveLength(1)
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
          onJobEnd: payload => ruleEndEvents.push(payload.cache),
        },
        runner: {
          cache: { location: cachePath },
        },
        setupConfig: createSetupConfig(),
      })
      const cacheBody = await readCacheBody(cachePath)

      expect(result.diagnostics[0]?.message).toBe('2')
      expect(ruleEndEvents).toEqual([
        'miss',
      ])
      expect(Object.values(cacheBody.owners)[0]?.slots).toHaveLength(1)
      expect(Object.keys(cacheBody.entries)).toHaveLength(1)
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
  })

  it('rejects create-time diagnostics even with an explicit filePath', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-create-diagnostic-order-'))
    const filePath = join(root, 'demo.txt')
    await writeFile(filePath, 'hello\n')
    const rule = defineRule({
      create: (ctx) => {
        ctx.report({ filePath, message: 'create-time diagnostic' })
        return {}
      },
    })

    await expect(runAlint({
      config: createConfig(
        { create: rule },
        { 'company/create': 'warn' },
        {},
        { language: 'text/plain' },
      ),
      files: [filePath],
      setupConfig: createSetupConfig(),
    })).rejects.toThrow('Cannot report a diagnostic outside an active rule job.')
  })

  it('rejects create-time usage without silently dropping it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-create-usage-order-'))
    const filePath = join(root, 'demo.txt')
    await writeFile(filePath, 'hello\n')
    const rule = defineRule({
      create: (ctx) => {
        ctx.metering.recordUsage({ modelId: 'model', providerId: 'provider' })
        return {}
      },
    })

    await expect(runAlint({
      config: createConfig(
        { create: rule },
        { 'company/create': 'warn' },
        {},
        { language: 'text/plain' },
      ),
      files: [filePath],
      setupConfig: createSetupConfig(),
    })).rejects.toThrow('Cannot record usage outside an active rule job.')
  })

  it('uses four rule permits by default', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-default-rule-concurrency-'))
    const files = Array.from({ length: 8 }, (_, index) => join(root, `${index}.txt`))
    await Promise.all(files.map((file, index) => writeFile(file, `${index}\n`)))
    let active = 0
    let maximum = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const rule = defineRule({
      create: () => ({
        onTargetFile: async () => {
          active += 1
          maximum = Math.max(maximum, active)
          if (active === 4)
            release()
          await gate
          active -= 1
        },
      }),
    })

    await runAlint({
      config: createConfig({ concurrency: rule }, { 'company/concurrency': 'warn' }, {}, { language: 'text/plain' }),
      cwd: root,
      files,
      setupConfig: createSetupConfig(),
    })

    expect(maximum).toBe(4)
  })

  it('shares one rule concurrency cap across source, directory, and project jobs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-cross-target-concurrency-'))
    const filePath = join(root, 'demo.ts')
    const directoryPath = join(root, 'workspace')
    await writeFile(filePath, 'export class Demo {}\nexport function demo() {}\n')
    const started: string[] = []
    let active = 0
    let maximum = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const hold = async (kind: string): Promise<void> => {
      started.push(kind)
      active += 1
      maximum = Math.max(maximum, active)
      if (active === 2)
        release()
      await gate
      active -= 1
    }
    const rules = {
      class: defineRule({ create: () => ({ onTargetClass: () => hold('class') }) }),
      directory: defineRule({ create: () => ({ onTargetDirectory: () => hold('directory') }) }),
      file: defineRule({ create: () => ({ onTargetFile: () => hold('file') }) }),
      function: defineRule({ create: () => ({ onTargetFunction: () => hold('function') }) }),
      project: defineRule({ create: () => ({ onTargetProject: () => hold('project') }) }),
    }

    await runAlint({
      config: createConfig(rules, {
        'company/class': 'warn',
        'company/directory': 'warn',
        'company/file': 'warn',
        'company/function': 'warn',
        'company/project': 'warn',
      }),
      cwd: root,
      directories: [directoryPath],
      files: [filePath],
      runner: { ruleConcurrency: 2 },
      setupConfig: createSetupConfig(),
    })

    expect(new Set(started)).toEqual(new Set(['class', 'directory', 'file', 'function', 'project']))
    expect(maximum).toBe(2)
  })

  it('allows one RuleRuntime to overlap while keeping job context isolated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-concurrent-runtime-context-'))
    const filePath = join(root, 'demo.ts')
    await writeFile(filePath, 'export class Demo {}\nexport function demo() {}\n')
    const visited: string[] = []
    let active = 0
    let maximum = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const rule = defineRule({
      create: ctx => ({
        onTargetWith: async (target) => {
          if (target.kind === 'project' || target.kind === 'directory')
            return
          active += 1
          maximum = Math.max(maximum, active)
          ctx.report({ message: target.kind })
          visited.push(`${target.kind}:${ctx.signal?.aborted}`)
          if (active === 3)
            release()
          await gate
          active -= 1
        },
      }),
    })

    await runAlint({
      config: createConfig({ context: rule }, { 'company/context': 'warn' }),
      cwd: root,
      files: [filePath],
      runner: { ruleConcurrency: 8 },
      setupConfig: createSetupConfig(),
    })

    expect(visited).toEqual(['file:false', 'class:false', 'function:false'])
    expect(maximum).toBe(3)
  })

  it('keeps diagnostics and usage input ordered when jobs finish out of order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-opposite-completion-'))
    const filePath = join(root, 'demo.txt')
    await writeFile(filePath, 'hello\n')

    const runWithCompletionOrder = async (completionOrder: number[]) => {
      const releases = Array.from({ length: 3 }, () => {
        let release!: () => void
        const promise = new Promise<void>((resolve) => {
          release = resolve
        })
        return { promise, release }
      })
      let started = 0
      let allStarted!: () => void
      const startedPromise = new Promise<void>((resolve) => {
        allStarted = resolve
      })
      const names = ['first', 'second', 'third']
      const observationOrder: string[] = []
      const rules = Object.fromEntries(names.map((name, index) => [name, defineRule({
        create: ctx => ({
          onTargetFile: async () => {
            started += 1
            if (started === names.length)
              allStarted()
            await releases[index]!.promise
            observationOrder.push(name)
            ctx.report({ message: `${name}:diagnostic:1` })
            ctx.report({ message: `${name}:diagnostic:2` })
            ctx.metering.recordUsage({ inputTokens: index + 1, modelId: `${name}:model:1`, providerId: 'test' })
            ctx.metering.recordUsage({ modelId: `${name}:model:2`, outputTokens: index + 1, providerId: 'test' })
          },
        }),
      })]))
      const run = runAlint({
        config: createConfig(rules, {
          'company/first': 'warn',
          'company/second': 'warn',
          'company/third': 'warn',
        }, {}, { language: 'text/plain' }),
        files: [filePath],
        runner: { cache: false, ruleConcurrency: 3 },
        setupConfig: createSetupConfig(),
      })

      await startedPromise
      for (const index of completionOrder) {
        releases[index]!.release()
        await Promise.resolve()
      }
      const result = await run
      return {
        observationOrder,
        projected: {
          diagnostics: result.diagnostics,
          usage: result.usage.records,
        },
      }
    }

    const forward = await runWithCompletionOrder([0, 1, 2])
    const reverse = await runWithCompletionOrder([2, 1, 0])

    expect(forward.observationOrder).toEqual(['first', 'second', 'third'])
    expect(reverse.observationOrder).toEqual(['third', 'second', 'first'])
    expect(reverse.projected).toEqual(forward.projected)
    expect(forward.projected.diagnostics.map(diagnostic => diagnostic.message)).toEqual([
      'first:diagnostic:1',
      'first:diagnostic:2',
      'second:diagnostic:1',
      'second:diagnostic:2',
      'third:diagnostic:1',
      'third:diagnostic:2',
    ])
    expect(forward.projected.usage.map(record => record.modelId)).toEqual([
      'first:model:1',
      'first:model:2',
      'second:model:1',
      'second:model:2',
      'third:model:1',
      'third:model:2',
    ])
  })

  it('drains later jobs and orders aggregate failures by planned job index', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-failure-drain-'))
    const filePath = join(root, 'demo.txt')
    const visited: string[] = []
    await writeFile(filePath, 'hello\n')
    const names = Array.from({ length: 8 }, (_, index) => `job-${index}`)
    const rules = Object.fromEntries(names.map((name, index) => [name, defineRule({
      create: () => ({
        onTargetFile: () => {
          visited.push(name)
          if (index === 1 || index === 4)
            throw new Error(`${name}:failure`)
        },
      }),
    })]))
    const enabledRules = Object.fromEntries(names.map(name => [`company/${name}`, 'warn' as const]))

    let runError: unknown
    try {
      await runAlint({
        config: createConfig(
          rules,
          enabledRules,
          {},
          { language: 'text/plain' },
        ),
        files: [filePath],
        runner: { ruleConcurrency: 3 },
        setupConfig: createSetupConfig(),
      })
    }
    catch (error) {
      runError = error
    }

    expect(runError).toBeInstanceOf(AlintRunError)
    expect((runError as AlintRunError).failures.map(failure => failure.message)).toEqual([
      'job-1:failure',
      'job-4:failure',
    ])
    expect((runError as AlintRunError).result.execution).toMatchObject({ completed: 6, failed: 2, planned: 8, queued: 0, running: 0 })
    expect((runError as AlintRunError).cause).toBeInstanceOf(AggregateError)
    expect(visited).toEqual(names)
  })

  it('cancels queued jobs without emitting rule events for them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-mid-run-cancel-'))
    const filePath = join(root, 'demo.ts')
    const controller = new AbortController()
    const starts: number[] = []
    const ends: number[] = []
    await writeFile(filePath, 'export class Demo {}\nexport function demo() {}\n')
    const rule = defineRule({
      create: () => ({ onTargetWith: () => {} }),
    })

    let runError: unknown
    try {
      await runAlint({
        config: createConfig({ cancel: rule }, { 'company/cancel': 'warn' }),
        files: [filePath],
        progress: {
          onJobEnd: payload => ends.push(payload.job.index),
          onJobStart: (payload) => {
            starts.push(payload.job.index)
            controller.abort('stop')
          },
        },
        runner: { ruleConcurrency: 1 },
        setupConfig: createSetupConfig(),
        signal: controller.signal,
      })
    }
    catch (error) {
      runError = error
    }

    expect(runError).toBeInstanceOf(AlintRunCancelledError)
    expect((runError as AlintRunCancelledError).cause).toBe('stop')
    expect((runError as AlintRunCancelledError).result.execution).toMatchObject({ cancelled: 4, queued: 0, running: 0 })
    expect(starts).toEqual([1])
    expect(ends).toEqual([1])
  })

  it('aborts the running handler signal and never starts queued jobs after run cancellation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-handler-cancel-'))
    const filePath = join(root, 'demo.ts')
    const controller = new AbortController()
    const observedSignals: AbortSignal[] = []
    let started = 0

    await writeFile(filePath, 'export class Demo {}\nexport function demo() {}\n')

    const rule = defineRule({
      create: ctx => ({
        onTargetWith: async () => {
          started += 1
          const signal = ctx.signal

          if (!signal)
            throw new Error('missing rule signal')

          observedSignals.push(signal)
          controller.abort('stop')
          await Promise.resolve()
        },
      }),
    })

    let runError: unknown
    try {
      await runAlint({
        config: createConfig({ cancel: rule }, { 'company/cancel': 'warn' }),
        files: [filePath],
        runner: { cache: false, ruleConcurrency: 1 },
        setupConfig: createSetupConfig(),
        signal: controller.signal,
      })
    }
    catch (error) {
      runError = error
    }

    expect(runError).toBeInstanceOf(AlintRunCancelledError)
    expect((runError as AlintRunCancelledError).result.execution).toMatchObject({ cancelled: 4, queued: 0, running: 0 })
    expect(started).toBe(1)
    expect(observedSignals).toHaveLength(1)
    expect(observedSignals[0]?.aborted).toBe(true)
  })

  it('cancels every job without invoking handlers when pre-aborted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-pre-aborted-'))
    const filePath = join(root, 'demo.txt')
    const controller = new AbortController()
    const events: string[] = []
    await writeFile(filePath, 'hello\n')
    controller.abort(undefined)
    const reason = controller.signal.reason
    const rule = defineRule({
      create: () => ({
        onTargetFile: () => {
          events.push('handler')
        },
      }),
    })

    let runError: unknown
    try {
      await runAlint({
        config: createConfig({ cancel: rule }, { 'company/cancel': 'warn' }, {}, { language: 'text/plain' }),
        files: [filePath],
        setupConfig: createSetupConfig(),
        signal: controller.signal,
      })
    }
    catch (error) {
      runError = error
    }

    expect(runError).toBeInstanceOf(AlintRunCancelledError)
    expect((runError as AlintRunCancelledError).cause).toBe(reason)
    expect((runError as AlintRunCancelledError).result.execution).toMatchObject({ cancelled: 1, queued: 0, running: 0 })
    expect(events).toEqual([])
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
        ruleConcurrency: 2,
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
        onDiagnostic: payload => events.push(`${payload.diagnostic.message}:${payload.job.target.kind}`),
      },
      setupConfig: createSetupConfig(),
    })

    expect(events).toEqual([
      'Problem found:file',
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
          payload.job.inputPath,
          payload.job.target.kind,
          payload.job.ruleId,
          payload.record.totalTokens,
        ].join(':')),
      },
      setupConfig: createSetupConfig(),
    })

    expect(usageEvents).toEqual([
      `${filePath}:function:company/record-usage:6`,
    ])
  })

  it('emits failed rule progress before rethrowing rule failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-progress-error-'))
    const filePath = join(root, 'demo.txt')
    const cachePath = join(root, '.alintcache')
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
        onJobEnd: payload => events.push(`${payload.state}:${payload.job.ruleId}`),
        onRunEnd: payload => events.push(`run:${payload.execution.completed}/${payload.execution.failed}/${payload.execution.planned}`),
      },
      runner: { cache: { location: cachePath } },
      setupConfig: createSetupConfig(),
    })).rejects.toMatchObject({
      failures: [{ message: 'rule exploded' }],
      message: '1 rule execution failed.',
    })

    expect(events).toEqual([
      'failed:company/explode',
      'run:0/1/1',
    ])
    const cacheBody = await readCacheBody(cachePath)
    expect(Object.values(cacheBody.owners)[0]?.slots).toHaveLength(0)
    expect(Object.keys(cacheBody.entries)).toHaveLength(0)
  })

  it.each(['diagnostic', 'usage'] as const)('propagates a %s reporter exception raised during a handler', async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'alint-live-diagnostic-progress-'))
    const filePath = join(root, 'demo.txt')
    const sentinel = new Error('live diagnostic reporter failed')
    await writeFile(filePath, 'hello\n')
    const rule = defineRule({
      create: ctx => ({
        onTargetFile: () => kind === 'diagnostic'
          ? ctx.report({ message: 'finding' })
          : ctx.metering.recordUsage({ modelId: 'test', providerId: 'test' }),
      }),
    })

    let runError: unknown
    try {
      await runAlint({
        config: createConfig({ live: rule }, { 'company/live': 'warn' }, {}, { language: 'text/plain' }),
        files: [filePath],
        progress: {
          onDiagnostic: kind === 'diagnostic' ? () => { throw sentinel } : undefined,
          onUsage: kind === 'usage' ? () => { throw sentinel } : undefined,
        },
        setupConfig: createSetupConfig(),
      })
    }
    catch (error) {
      runError = error
    }

    expect(runError).toBe(sentinel)
  })

  it('propagates a reporter exception caught by the handler', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-caught-diagnostic-progress-'))
    const filePath = join(root, 'demo.txt')
    const firstSentinel = new Error('first caught diagnostic reporter failed')
    const secondSentinel = new Error('second caught diagnostic reporter failed')
    const sentinels = [firstSentinel, secondSentinel]
    let callbackIndex = 0
    await writeFile(filePath, 'hello\n')
    const rule = defineRule({
      create: ctx => ({
        onTargetFile: () => {
          for (const message of ['first finding', 'second finding']) {
            try {
              ctx.report({ message })
            }
            catch {
              // A rule cannot suppress an infrastructure failure from the reporter.
            }
          }
        },
      }),
    })

    let runError: unknown
    try {
      await runAlint({
        config: createConfig({ live: rule }, { 'company/live': 'warn' }, {}, { language: 'text/plain' }),
        files: [filePath],
        progress: { onDiagnostic: () => { throw sentinels[callbackIndex++] } },
        setupConfig: createSetupConfig(),
      })
    }
    catch (error) {
      runError = error
    }

    expect(runError).toBe(firstSentinel)
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

    it('leaves legacy cache bytes unchanged even without input files', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-cache-only-legacy-'))
      const cachePath = join(root, '.alintcache')
      const original = '{"legacy":true}\n'
      await writeFile(cachePath, original)

      await runAlint({
        cacheOnly: true,
        cwd: root,
        runner: { cache: { location: cachePath } },
        setupConfig: createSetupConfig(),
      })

      expect(await readFile(cachePath, 'utf8')).toBe(original)
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
          onJobEnd: payload => ruleEndEvents.push(`${payload.cache}:${payload.state}`),
        },
        setupConfig: createSetupConfig(),
      })

      expect(handlerCalls).toBe(0)
      expect(result.diagnostics).toEqual([])
      expect(result.execution).toEqual({
        cached: 0,
        cancelled: 0,
        completed: 0,
        failed: 0,
        planned: 1,
        queued: 0,
        running: 0,
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
          onJobEnd: payload => ruleEndEvents.push(`${payload.cache}:${payload.state}`),
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
        cancelled: 0,
        completed: 0,
        failed: 0,
        planned: 1,
        queued: 0,
        running: 0,
        skipped: 0,
      })
      expect(ruleEndEvents).toEqual(['hit:cached'])
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
          onJobEnd: payload => ruleEndEvents.push(`${payload.job.ruleId}:${payload.cache}:${payload.state}`),
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
        cancelled: 0,
        completed: 0,
        failed: 0,
        planned: 2,
        queued: 0,
        running: 0,
        skipped: 1,
      })
      expect(ruleEndEvents).toEqual([
        'company/first:hit:cached',
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
          onJobEnd: payload => ruleEndEvents.push(`${payload.cache}:${payload.state}`),
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

  describe('signal', () => {
    it('stops starting rules once the run is aborted', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-abort-stops-'))
      const filePath = join(root, 'demo.ts')
      const controller = new AbortController()
      const visited: string[] = []

      await writeFile(filePath, [
        'export function first() {}',
        'export function second() {}',
        'export function third() {}',
      ].join('\n'))

      // Abort from inside the first rule, standing in for a user cancelling mid-run.
      const rule = defineRule({
        create: () => ({
          onTargetFunction: (target) => {
            visited.push(target.name ?? 'anonymous')
            controller.abort()
          },
        }),
      })

      let runError: unknown

      try {
        await runAlint({
          config: createConfig({ review: rule }, { 'company/review': 'warn' }),
          cwd: root,
          files: [filePath],
          setupConfig: createSetupConfig(),
          signal: controller.signal,
        })
      }
      catch (error) {
        runError = error
      }

      expect(runError).toBeInstanceOf(AlintAbortError)
      expect(visited).toEqual(['first'])
    })

    it('retains completed work when a later job is externally aborted', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-abort-retains-completed-'))
      const filePath = join(root, 'demo.ts')
      const cachePath = join(root, '.alintcache')
      const controller = new AbortController()
      const calls = { first: 0, second: 0 }
      await writeFile(filePath, [
        'export function first() {}',
        'export function second() {}',
      ].join('\n'))
      const rule = defineRule({
        create: () => ({
          onTargetFunction: (target) => {
            if (target.name === 'first')
              calls.first += 1
            if (target.name === 'second')
              calls.second += 1
          },
        }),
      })
      const config = createConfig({ review: rule }, { 'company/review': 'warn' })

      await expect(runAlint({
        config,
        cwd: root,
        files: [filePath],
        progress: {
          onJobStart: ({ job }) => {
            if (job.target.name === 'second')
              controller.abort()
          },
        },
        runner: { cache: { location: cachePath }, ruleConcurrency: 1 },
        setupConfig: createSetupConfig(),
        signal: controller.signal,
      })).rejects.toBeInstanceOf(AlintAbortError)
      const abortedBody = await readCacheBody(cachePath)

      expect(calls).toEqual({ first: 1, second: 0 })
      expect(Object.values(abortedBody.owners)[0]?.slots).toHaveLength(1)
      expect(Object.keys(abortedBody.entries)).toHaveLength(1)
      expect(Object.values(abortedBody.entries)[0]?.target.name).toBe('first')

      const replayed = await runAlint({
        config,
        cwd: root,
        files: [filePath],
        runner: { cache: { location: cachePath }, ruleConcurrency: 1 },
        setupConfig: createSetupConfig(),
      })

      expect(calls).toEqual({ first: 1, second: 1 })
      expect(replayed.execution.cached).toBe(1)
      expect(replayed.execution.completed).toBe(1)
    })

    it('reports an abort as cancellation rather than a rule failure', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-abort-not-errored-'))
      const filePath = join(root, 'demo.ts')
      const controller = new AbortController()
      const ruleEndEvents: string[] = []

      await writeFile(filePath, 'export function load() {}\n')

      // A rule whose model call is cancelled throws, exactly as generateStructured would.
      const rule = defineRule({
        create: ctx => ({
          onTargetFunction: () => {
            controller.abort()
            ctx.signal?.throwIfAborted()
          },
        }),
      })

      let runError: unknown

      try {
        await runAlint({
          config: createConfig({ review: rule }, { 'company/review': 'warn' }),
          cwd: root,
          files: [filePath],
          progress: {
            onJobEnd: payload => ruleEndEvents.push(payload.state),
          },
          setupConfig: createSetupConfig(),
          signal: controller.signal,
        })
      }
      catch (error) {
        runError = error
      }

      expect(runError).toBeInstanceOf(AlintAbortError)
      expect((runError as AlintAbortError).result.execution.failed).toBe(0)
      expect(ruleEndEvents).toEqual(['cancelled'])
    })

    it('keeps diagnostics but does not cache a job cancelled by the external signal', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-abort-keeps-work-'))
      const filePath = join(root, 'demo.ts')
      const cachePath = join(root, '.alintcache')
      const controller = new AbortController()
      const handlerCalls: string[] = []

      await writeFile(filePath, [
        'export function first() {}',
        'export function second() {}',
      ].join('\n'))

      const rule = defineRule({
        create: ctx => ({
          onTargetFunction: (target) => {
            handlerCalls.push(target.name ?? 'anonymous')
            ctx.report({ message: `checked ${target.name}` })

            if (target.name === 'first') {
              controller.abort()
            }
          },
        }),
      })
      const config = createConfig({ review: rule }, { 'company/review': 'warn' })

      let runError: unknown

      try {
        await runAlint({
          config,
          cwd: root,
          files: [filePath],
          runner: { cache: { location: cachePath } },
          setupConfig: createSetupConfig(),
          signal: controller.signal,
        })
      }
      catch (error) {
        runError = error
      }

      expect(runError).toBeInstanceOf(AlintAbortError)
      expect((runError as AlintAbortError).result.diagnostics).toMatchObject([
        { message: 'checked first' },
      ])

      const replayed = await runAlint({
        config,
        cwd: root,
        files: [filePath],
        runner: { cache: { location: cachePath } },
        setupConfig: createSetupConfig(),
      })

      expect(handlerCalls).toEqual(['first', 'first', 'second'])
      expect(replayed.diagnostics).toMatchObject([
        { message: 'checked first' },
        { message: 'checked second' },
      ])
    })

    it('does not reach a rule when the signal is already aborted', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-abort-upfront-'))
      const filePath = join(root, 'demo.ts')
      const controller = new AbortController()
      let handlerCalls = 0

      await writeFile(filePath, 'export function load() {}\n')
      controller.abort()

      const rule = defineRule({
        create: () => ({
          onTargetFunction: () => {
            handlerCalls += 1
          },
        }),
      })

      await expect(runAlint({
        config: createConfig({ review: rule }, { 'company/review': 'warn' }),
        cwd: root,
        files: [filePath],
        setupConfig: createSetupConfig(),
        signal: controller.signal,
      })).rejects.toBeInstanceOf(AlintAbortError)

      expect(handlerCalls).toBe(0)
    })

    it('exposes the signal on rule context so rules can forward it', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-abort-ctx-'))
      const filePath = join(root, 'demo.ts')
      const controller = new AbortController()
      const seen: (AbortSignal | undefined)[] = []

      await writeFile(filePath, 'export function load() {}\n')

      const rule = defineRule({
        create: ctx => ({
          onTargetFunction: () => {
            seen.push(ctx.signal)
          },
        }),
      })

      await runAlint({
        config: createConfig({ review: rule }, { 'company/review': 'warn' }),
        cwd: root,
        files: [filePath],
        setupConfig: createSetupConfig(),
        signal: controller.signal,
      })

      expect(seen).toHaveLength(1)
      expect(seen[0]?.aborted).toBe(false)
    })
  })

  describe('projectTargets', () => {
    it('skips the project pass when projectTargets is false', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-project-targets-off-'))
      const filePath = join(root, 'demo.ts')
      let projectCalls = 0
      let fileCalls = 0

      await writeFile(filePath, 'export function load() {}\n')

      const rule = defineRule({
        create: () => ({
          onTargetFile: () => {
            fileCalls += 1
          },
          onTargetProject: () => {
            projectCalls += 1
          },
        }),
      })

      const result = await runAlint({
        config: createConfig({ review: rule }, { 'company/review': 'warn' }),
        cwd: root,
        files: [filePath],
        projectTargets: false,
        setupConfig: createSetupConfig(),
      })

      expect(projectCalls).toBe(0)
      // File-scoped work still runs; only the project pass is dropped.
      expect(fileCalls).toBe(1)
      // The skipped project execution must not inflate the planned count either.
      expect(result.execution).toMatchObject({ completed: 1, planned: 1 })
    })

    it('runs the project pass by default', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-project-targets-default-'))
      const filePath = join(root, 'demo.ts')
      let projectCalls = 0

      await writeFile(filePath, 'export function load() {}\n')

      const rule = defineRule({
        create: () => ({
          onTargetProject: () => {
            projectCalls += 1
          },
        }),
      })

      await runAlint({
        config: createConfig({ review: rule }, { 'company/review': 'warn' }),
        cwd: root,
        files: [filePath],
        setupConfig: createSetupConfig(),
      })

      expect(projectCalls).toBe(1)
    })

    it('drops only the project kind for an onTargetWith rule', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-project-targets-with-'))
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

      await runAlint({
        config: createConfig(
          { review: rule },
          { 'company/review': 'warn' },
          {},
          { language: 'text/plain' },
        ),
        cwd: root,
        directories: [directoryPath],
        files: [filePath],
        projectTargets: false,
        setupConfig: createSetupConfig(),
      })

      // Without projectTargets: false this is ['file', 'directory', 'project'].
      expect(visited).toEqual(['file', 'directory'])
    })

    it('does not report project rules as skipped in a partial cacheOnly run', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-project-targets-cache-only-'))
      const filePath = join(root, 'demo.ts')
      const jobEndEvents: string[] = []

      await writeFile(filePath, 'export function load() {}\n')

      // A project-only rule can never be served from a per-file cache, so a passive editor
      // pass must exclude it rather than count it forever as "needs a run".
      const rule = defineRule({
        create: () => ({
          onTargetProject: () => {},
        }),
      })

      const result = await runAlint({
        cacheOnly: true,
        config: createConfig({ review: rule }, { 'company/review': 'warn' }),
        cwd: root,
        files: [filePath],
        progress: {
          onJobEnd: payload => jobEndEvents.push(`${payload.job.target.kind}:${payload.state}`),
        },
        projectTargets: false,
        setupConfig: createSetupConfig(),
      })

      expect(jobEndEvents).toEqual([])
      expect(result.execution).toMatchObject({ planned: 0, skipped: 0 })
    })
  })
})
