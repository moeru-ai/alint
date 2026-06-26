import type { SetupConfig } from '../config/types'

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

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

  it('runs function rules and reports diagnostics with resolved model metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-engine-'))
    const filePath = join(root, 'demo.ts')

    await writeFile(filePath, [
      'export function load() {',
      '  return 1',
      '}',
    ].join('\n'))

    const rule = defineRule({
      create: ctx => ({
        onFunction: async (functionNode) => {
          const model = await ctx.model()

          ctx.report({
            evidence: {
              modelName: model.name,
              source: ctx.src.getText(functionNode),
            },
            loc: functionNode.loc,
            message: `loaded by ${model.id}`,
          })
        },
      }),
      model: {
        capabilities: ['structured-output'],
      },
    })

    const plugin = definePlugin({
      rules: {
        'prefer-load': rule,
      },
      scope: 'company',
    })

    const result = await runAlint({
      config: defineConfig({
        plugins: [plugin],
        rules: {
          'company/prefer-load': 'warn',
        },
      }),
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
    const root = await mkdtemp(join(tmpdir(), 'alint-engine-'))
    const filePath = join(root, 'demo.ts')

    await writeFile(filePath, 'export function load() {}\n')

    const rule = defineRule({
      create: ctx => ({
        onFunction: async (functionNode) => {
          const model = await ctx.model('default')

          ctx.report({
            filePath: functionNode.file.path,
            message: `loaded by ${model.id}`,
          })
        },
      }),
      model: {
        capabilities: ['structured-output'],
      },
    })

    const result = await runAlint({
      config: defineConfig({
        plugins: [
          definePlugin({
            rules: { 'prefer-load': rule },
            scope: 'company',
          }),
        ],
        rules: {
          'company/prefer-load': 'warn',
        },
      }),
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

  it('does not carry model metadata into later files without model resolution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-engine-'))
    const firstFilePath = join(root, 'a.ts')
    const secondFilePath = join(root, 'b.ts')

    await writeFile(firstFilePath, 'export function first() {}\n')
    await writeFile(secondFilePath, 'export function second() {}\n')

    const rule = defineRule({
      create: ctx => ({
        onFile: async (file) => {
          if (file.path === firstFilePath) {
            await ctx.model()
          }

          ctx.report({
            filePath: file.path,
            message: `visited ${file.path}`,
          })
        },
      }),
      model: {
        capabilities: ['structured-output'],
      },
    })

    const result = await runAlint({
      config: defineConfig({
        plugins: [
          definePlugin({
            rules: { 'visit-files': rule },
            scope: 'company',
          }),
        ],
        rules: {
          'company/visit-files': 'warn',
        },
      }),
      files: [firstFilePath, secondFilePath],
      setupConfig: createSetupConfig(),
    })

    expect(result.diagnostics).toHaveLength(2)
    expect(result.diagnostics[0]?.model?.resolvedId).toBe('local:qwen-8b')
    expect(result.diagnostics[1]?.model).toBeUndefined()
  })

  it('does not carry model metadata into later reports in the same file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-engine-'))
    const filePath = join(root, 'demo.ts')

    await writeFile(filePath, 'export function load() {}\n')

    const rule = defineRule({
      create: ctx => ({
        onFile: async (file) => {
          await ctx.model()
          ctx.report({
            filePath: file.path,
            message: 'with model',
          })
          ctx.report({
            filePath: file.path,
            message: 'without model',
          })
        },
      }),
      model: {
        capabilities: ['structured-output'],
      },
    })

    const result = await runAlint({
      config: defineConfig({
        plugins: [
          definePlugin({
            rules: { 'report-twice': rule },
            scope: 'company',
          }),
        ],
        rules: {
          'company/report-twice': 'warn',
        },
      }),
      files: [filePath],
      setupConfig: createSetupConfig(),
    })

    expect(result.diagnostics).toHaveLength(2)
    expect(result.diagnostics[0]?.model?.resolvedId).toBe('local:qwen-8b')
    expect(result.diagnostics[1]?.model).toBeUndefined()
  })

  it('accumulates usage records emitted by rules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-engine-'))
    const filePath = join(root, 'demo.ts')

    await writeFile(filePath, 'export function load() {}\n')

    const rule = defineRule({
      create: ctx => ({
        onFile: (file) => {
          ctx.metering.recordUsage({
            filePath: file.path,
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
            filePath: file.path,
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
      config: defineConfig({
        plugins: [
          definePlugin({
            rules: { 'record-usage': rule },
            scope: 'company',
          }),
        ],
        rules: {
          'company/record-usage': 'warn',
        },
      }),
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
    it('reuses cached function diagnostics and usage on unchanged targets', async () => {
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
          onFunction: (functionNode) => {
            handlerCalls += 1
            ctx.report({
              loc: functionNode.loc,
              message: `checked ${functionNode.name}`,
            })
            ctx.metering.recordUsage({
              filePath: functionNode.file.path,
              inputTokens: 7,
              modelId: 'local:qwen-8b',
              outputTokens: 3,
              providerId: 'ollama',
              totalTokens: 10,
            })
          },
        }),
      })
      const config = defineConfig({
        plugins: [
          definePlugin({
            rules: { cached: rule },
            scope: 'company',
          }),
        ],
        rules: {
          'company/cached': 'warn',
        },
      })

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
          onRuleEnd: payload => ruleEndEvents.push(`${payload.cache}:${payload.state}`),
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
          filePath,
          message: 'checked load',
          ruleId: 'company/cached',
        },
      ])
      expect(result.usage).toMatchObject({
        inputTokens: 7,
        outputTokens: 3,
        totalTokens: 10,
      })
      expect(result.usage.records).toMatchObject([
        {
          filePath,
          ruleId: 'company/cached',
          totalTokens: 10,
        },
      ])
      expect(diagnosticEvents).toEqual([
        'checked load:function',
      ])
      expect(usageEvents).toEqual([
        '10:function:10',
      ])
      expect(ruleEndEvents).toEqual([
        'hit:completed',
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
          onFunction: (functionNode) => {
            const name = functionNode.name ?? 'anonymous'
            calls.set(name, (calls.get(name) ?? 0) + 1)
            ctx.report({
              message: `${name}:${ctx.src.getText(functionNode).includes('return 3') ? 'changed' : 'original'}`,
            })
          },
        }),
      })
      const config = defineConfig({
        plugins: [
          definePlugin({
            rules: { siblings: rule },
            scope: 'company',
          }),
        ],
        rules: {
          'company/siblings': 'warn',
        },
      })

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
          onRuleEnd: payload => ruleEndEvents.push(`${payload.path.target.name}:${payload.cache}`),
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
          onFunction: (functionNode) => {
            handlerCalls += 1
            ctx.report({
              message: `call ${handlerCalls} ${functionNode.name}`,
            })
          },
        }),
      })
      const config = defineConfig({
        plugins: [
          definePlugin({
            rules: { uncached: rule },
            scope: 'company',
          }),
        ],
        rules: {
          'company/uncached': 'warn',
        },
      })

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
          onRuleEnd: payload => ruleEndEvents.push(payload.cache),
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
        'miss',
      ])
    })

    it('reports cache hits in progress counters', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-cache-progress-'))
      const filePath = join(root, 'demo.ts')
      const cachePath = join(root, '.alintcache')
      const events: string[] = []

      await writeFile(filePath, [
        'export function first() {}',
        'export function second() {}',
      ].join('\n'))

      const rule = defineRule({
        create: () => ({
          onFunction: () => {},
        }),
      })
      const config = defineConfig({
        plugins: [
          definePlugin({
            rules: { progress: rule },
            scope: 'company',
          }),
        ],
        rules: {
          'company/progress': 'warn',
        },
      })

      await runAlint({
        config,
        files: [filePath],
        runner: {
          cache: { location: cachePath },
        },
        setupConfig: createSetupConfig(),
      })

      await runAlint({
        config,
        files: [filePath],
        progress: {
          onRuleEnd: payload => events.push(`rule:${payload.path.target.name}:${payload.cache}:${payload.state}`),
          onRunEnd: payload => events.push(`run:${payload.completed}/${payload.cached}/${payload.errored}/${payload.planned}`),
          onRunStart: payload => events.push(`start:${payload.planned}`),
        },
        runner: {
          cache: { location: cachePath },
        },
        setupConfig: createSetupConfig(),
      })

      expect(events).toEqual([
        'start:2',
        'rule:first:hit:completed',
        'rule:second:hit:completed',
        'run:0/2/0/2',
      ])
    })

    it('does not mix concurrent miss diagnostics and usage between cached entries', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-cache-concurrent-miss-'))
      const firstFilePath = join(root, 'a.ts')
      const secondFilePath = join(root, 'b.ts')
      const cachePath = join(root, '.alintcache')
      let resolveFirstStarted!: () => void
      let resolveSecondFinished!: () => void
      const firstStarted = new Promise<void>((resolve) => {
        resolveFirstStarted = resolve
      })
      const secondFinished = new Promise<void>((resolve) => {
        resolveSecondFinished = resolve
      })
      let handlerCalls = 0

      await writeFile(firstFilePath, 'export function first() {}\n')
      await writeFile(secondFilePath, 'export function second() {}\n')

      const rule = defineRule({
        create: ctx => ({
          onFunction: async (functionNode) => {
            handlerCalls += 1

            if (functionNode.file.path === firstFilePath) {
              resolveFirstStarted()
              await secondFinished
              ctx.report({
                message: 'first diagnostic',
              })
              ctx.metering.recordUsage({
                filePath: functionNode.file.path,
                inputTokens: 10,
                modelId: 'local:qwen-8b',
                outputTokens: 1,
                providerId: 'ollama',
                totalTokens: 11,
              })
              return
            }

            await firstStarted
            ctx.report({
              message: 'second diagnostic',
            })
            ctx.metering.recordUsage({
              filePath: functionNode.file.path,
              inputTokens: 20,
              modelId: 'local:qwen-8b',
              outputTokens: 2,
              providerId: 'ollama',
              totalTokens: 22,
            })
            resolveSecondFinished()
          },
        }),
      })
      const config = defineConfig({
        plugins: [
          definePlugin({
            rules: { concurrent: rule },
            scope: 'company',
          }),
        ],
        rules: {
          'company/concurrent': 'warn',
        },
      })

      await runAlint({
        config,
        files: [firstFilePath, secondFilePath],
        runner: {
          cache: { location: cachePath },
          fileConcurrency: 2,
        },
        setupConfig: createSetupConfig(),
      })

      const result = await runAlint({
        config,
        files: [firstFilePath, secondFilePath],
        runner: {
          cache: { location: cachePath },
          fileConcurrency: 2,
        },
        setupConfig: createSetupConfig(),
      })

      expect(handlerCalls).toBe(2)
      expect(result.diagnostics.map(diagnostic => diagnostic.message)).toEqual([
        'first diagnostic',
        'second diagnostic',
      ])
      expect(result.usage.records.map(record => record.filePath)).toEqual([
        firstFilePath,
        secondFilePath,
      ])
      expect(result.usage.totalTokens).toBe(33)
    })

    it('invalidates cached entries when rule implementation changes', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alint-cache-rule-implementation-'))
      const filePath = join(root, 'demo.ts')
      const cachePath = join(root, '.alintcache')
      const ruleEndEvents: string[] = []

      await writeFile(filePath, 'export function load() {}\n')

      const firstRule = defineRule({
        create: ctx => ({
          onFunction: () => {
            ctx.report({
              message: 'first implementation',
            })
          },
        }),
      })
      const secondRule = defineRule({
        create: ctx => ({
          onFunction: () => {
            ctx.report({
              message: 'second implementation',
            })
          },
        }),
      })
      const createConfig = (rule: typeof firstRule) => defineConfig({
        plugins: [
          definePlugin({
            rules: { implementation: rule },
            scope: 'company',
          }),
        ],
        rules: {
          'company/implementation': 'warn',
        },
      })

      await runAlint({
        config: createConfig(firstRule),
        files: [filePath],
        runner: {
          cache: { location: cachePath },
        },
        setupConfig: createSetupConfig(),
      })

      const result = await runAlint({
        config: createConfig(secondRule),
        files: [filePath],
        progress: {
          onRuleEnd: payload => ruleEndEvents.push(payload.cache),
        },
        runner: {
          cache: { location: cachePath },
        },
        setupConfig: createSetupConfig(),
      })

      expect(result.diagnostics.map(diagnostic => diagnostic.message)).toEqual([
        'second implementation',
      ])
      expect(ruleEndEvents).toEqual([
        'miss',
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
          onFunction: () => {
            ctx.report({
              message: 'cached diagnostic',
            })
          },
        }),
      })
      const config = defineConfig({
        plugins: [
          definePlugin({
            rules: { replay: rule },
            scope: 'company',
          }),
        ],
        rules: {
          'company/replay': 'warn',
        },
      })

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
        'hit:errored',
      ])
    })
  })

  it('requires explicit filePath when reporting outside file context', async () => {
    const rule = defineRule({
      create: (ctx) => {
        ctx.report({
          message: 'reported during create',
        })

        return {}
      },
    })

    await expect(runAlint({
      config: defineConfig({
        plugins: [
          definePlugin({
            rules: { 'create-report': rule },
            scope: 'company',
          }),
        ],
        rules: {
          'company/create-report': 'warn',
        },
      }),
      files: [],
      setupConfig: createSetupConfig(),
    })).rejects.toThrow('Diagnostic for rule "company/create-report" is missing filePath.')
  })

  it('emits nested progress events for file function and class targets', async () => {
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
        onClass: () => {},
        onFile: () => {},
        onFunction: () => {},
      }),
    })

    await runAlint({
      config: defineConfig({
        plugins: [
          definePlugin({
            rules: { 'visit-all': rule },
            scope: 'company',
          }),
        ],
        rules: {
          'company/visit-all': 'warn',
        },
      }),
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

  it('emits progress in file target rule order for multiple rules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-progress-file-first-'))
    const firstFilePath = join(root, 'a.ts')
    const secondFilePath = join(root, 'b.ts')
    const events: string[] = []

    await writeFile(firstFilePath, 'export function first() {}\n')
    await writeFile(secondFilePath, 'export function second() {}\n')

    const firstRule = defineRule({
      create: () => ({
        onFile: () => {},
        onFunction: () => {},
      }),
    })
    const secondRule = defineRule({
      create: () => ({
        onFile: () => {},
        onFunction: () => {},
      }),
    })

    await runAlint({
      config: defineConfig({
        plugins: [
          definePlugin({
            rules: {
              first: firstRule,
              second: secondRule,
            },
            scope: 'company',
          }),
        ],
        rules: {
          'company/first': 'warn',
          'company/second': 'warn',
        },
      }),
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

  it('emits timing and per-file planned metadata in progress events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-progress-timing-'))
    const filePath = join(root, 'demo.ts')
    const events: string[] = []
    const times = [10, 20, 30, 40, 50, 60, 70, 80]

    await writeFile(filePath, 'export function load() {}\n')

    const rule = defineRule({
      create: () => ({
        onFile: () => {},
      }),
    })

    await runAlint({
      config: defineConfig({
        plugins: [
          definePlugin({
            rules: { timing: rule },
            scope: 'company',
          }),
        ],
        rules: {
          'company/timing': 'warn',
        },
      }),
      files: [filePath],
      progress: {
        onFileEnd: payload => events.push(`file:end:${payload.file.planned}:${payload.startedAt}:${payload.endedAt}`),
        onFileStart: payload => events.push(`file:start:${payload.file.planned}:${payload.startedAt}`),
        onRuleEnd: payload => events.push(`rule:end:${payload.startedAt}:${payload.endedAt}`),
        onRuleStart: payload => events.push(`rule:start:${payload.startedAt}`),
        onRunEnd: payload => events.push(`run:end:${payload.startedAt}:${payload.endedAt}`),
        onRunStart: payload => events.push(`run:start:${payload.files?.[0]?.planned}:${payload.startedAt}`),
      },
      runner: {
        clock: () => times.shift() ?? 999,
      },
      setupConfig: createSetupConfig(),
    })

    expect(events).toEqual([
      'run:start:1:10',
      'file:start:1:20',
      'rule:start:40',
      'rule:end:40:50',
      'file:end:1:20:60',
      'run:end:10:70',
    ])
  })

  it('runs files concurrently when file concurrency is greater than one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-concurrent-files-'))
    const firstFilePath = join(root, 'a.ts')
    const secondFilePath = join(root, 'b.ts')
    const events: string[] = []
    let resolveSecondStarted!: () => void
    const secondStarted = new Promise<void>((resolve) => {
      resolveSecondStarted = resolve
    })

    await writeFile(firstFilePath, 'export function first() {}\n')
    await writeFile(secondFilePath, 'export function second() {}\n')

    const rule = defineRule({
      create: () => ({
        onFile: async (file) => {
          events.push(`start:${file.path}`)

          if (file.path === firstFilePath) {
            await secondStarted
          }
          else {
            resolveSecondStarted()
          }

          events.push(`end:${file.path}`)
        },
      }),
    })

    await runAlint({
      config: defineConfig({
        plugins: [
          definePlugin({
            rules: { concurrent: rule },
            scope: 'company',
          }),
        ],
        rules: {
          'company/concurrent': 'warn',
        },
      }),
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
    const firstFilePath = join(root, 'a.ts')
    const secondFilePath = join(root, 'b.ts')
    let resolveFirstModelReady!: () => void
    let resolveSecondReported!: () => void
    const firstModelReady = new Promise<void>((resolve) => {
      resolveFirstModelReady = resolve
    })
    const secondReported = new Promise<void>((resolve) => {
      resolveSecondReported = resolve
    })

    await writeFile(firstFilePath, 'export function first() {}\n')
    await writeFile(secondFilePath, 'export function second() {}\n')

    const rule = defineRule({
      create: ctx => ({
        onFile: async (file) => {
          if (file.path === firstFilePath) {
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
      config: defineConfig({
        plugins: [
          definePlugin({
            rules: { isolated: rule },
            scope: 'company',
          }),
        ],
        rules: {
          'company/isolated': 'warn',
        },
      }),
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
    const filePath = join(root, 'demo.ts')
    const events: string[] = []

    await writeFile(filePath, 'export function load() {}\n')

    const rule = defineRule({
      create: ctx => ({
        onFile: (file) => {
          ctx.report({
            filePath: file.path,
            message: 'Problem found',
          })
        },
      }),
    })

    await runAlint({
      config: defineConfig({
        plugins: [
          definePlugin({
            rules: { diagnostic: rule },
            scope: 'company',
          }),
        ],
        rules: {
          'company/diagnostic': 'warn',
        },
      }),
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
        onFunction: (functionNode) => {
          ctx.metering.recordUsage({
            filePath: functionNode.file.path,
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
      config: defineConfig({
        plugins: [
          definePlugin({
            rules: { 'record-usage': rule },
            scope: 'company',
          }),
        ],
        rules: {
          'company/record-usage': 'warn',
        },
      }),
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
    const filePath = join(root, 'demo.ts')
    const events: string[] = []

    await writeFile(filePath, 'export function load() {}\n')

    const rule = defineRule({
      create: () => ({
        onFunction: () => {
          throw new Error('rule exploded')
        },
      }),
    })

    await expect(runAlint({
      config: defineConfig({
        plugins: [
          definePlugin({
            rules: { explode: rule },
            scope: 'company',
          }),
        ],
        rules: {
          'company/explode': 'warn',
        },
      }),
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
    const filePath = join(root, 'demo.ts')
    const events: string[] = []

    await writeFile(filePath, 'export function load() {}\n')

    const rule = defineRule({
      create: () => ({
        onFunction: () => {},
      }),
    })

    await expect(runAlint({
      config: defineConfig({
        plugins: [
          definePlugin({
            rules: { 'callback-success': rule },
            scope: 'company',
          }),
        ],
        rules: {
          'company/callback-success': 'warn',
        },
      }),
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
    const filePath = join(root, 'demo.ts')
    const events: string[] = []

    await writeFile(filePath, 'export function load() {}\n')

    const rule = defineRule({
      create: () => ({
        onFunction: () => {
          throw new Error('rule exploded')
        },
      }),
    })

    await expect(runAlint({
      config: defineConfig({
        plugins: [
          definePlugin({
            rules: { 'callback-error': rule },
            scope: 'company',
          }),
        ],
        rules: {
          'company/callback-error': 'warn',
        },
      }),
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
    const filePath = join(root, 'demo.ts')
    const events: string[] = []

    await writeFile(filePath, 'export function load() {}\n')

    const rule = defineRule({
      create: () => ({
        onFunction: () => {
          throw new Error('rule exploded')
        },
      }),
    })

    await expect(runAlint({
      config: defineConfig({
        plugins: [
          definePlugin({
            rules: { cleanup: rule },
            scope: 'company',
          }),
        ],
        rules: {
          'company/cleanup': 'warn',
        },
      }),
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
})
