import type { SetupConfig } from '../config/types'
import type { PluginDefinition, RuleConfigEntry, RuleDefinition } from '../dsl/types'

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

  it('runs explicit onTarget rules for .go through text/plain', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-go-target-'))
    const filePath = join(root, 'main.go')
    const visited: string[] = []

    await writeFile(filePath, 'package main\n')

    const rule = defineRule({
      create: ctx => ({
        onTarget: (target) => {
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

  it('exposes outputLanguage on rule context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-output-language-'))
    const filePath = join(root, 'demo.ts')

    await writeFile(filePath, 'export function load() {}\n')

    const rule = defineRule({
      create: ctx => ({
        onTarget: (target) => {
          if (target.kind !== 'file') {
            return
          }

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
        onTarget: () => {
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
        onTarget: () => {
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
        onTarget: async (target) => {
          const { answer } = await ctx.agent({
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

  it('ctx.agent throws a clear error when no agent is configured', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-agent-missing-'))
    const filePath = join(root, 'demo.txt')

    await writeFile(filePath, 'hello\n')

    const rule = defineRule({
      create: ctx => ({
        onTarget: async (target) => {
          await ctx.agent({
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
        onTarget: (target) => {
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
        onTarget: async (target) => {
          if (target.kind !== 'function') {
            return
          }

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
        onTarget: async (target) => {
          if (target.kind !== 'function') {
            return
          }

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
        onTarget: async (target) => {
          if (target.kind !== 'file') {
            return
          }

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
        onTarget: (target) => {
          if (target.kind !== 'file') {
            return
          }

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
          onTarget: (target) => {
            if (target.kind !== 'function') {
              return
            }

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
      expect(diagnosticEvents).toEqual([
        'checked load:function',
      ])
      expect(usageEvents).toEqual([
        '10:function:10',
      ])
      expect(ruleEndEvents).toEqual([
        'file:hit:completed',
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
          onTarget: (target) => {
            if (target.kind !== 'function') {
              return
            }

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
        'file:miss',
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
          onTarget: (target) => {
            if (target.kind !== 'function') {
              return
            }

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
        'file:miss',
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
          onTarget: () => {
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
          onTarget: (target) => {
            if (target.kind !== 'function') {
              return
            }

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
          onTarget: (target) => {
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
          onTarget: (target) => {
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
          onTarget: (target) => {
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
          onTarget: (target) => {
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
        onTarget: () => {},
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
        onTarget: () => {},
      }),
    })
    const secondRule = defineRule({
      create: () => ({
        onTarget: () => {},
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
        onTarget: () => {},
      }),
    })
    const secondRule = defineRule({
      create: () => ({
        onTarget: () => {},
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
    const events: string[] = []
    const times = [10, 20, 30, 40, 50, 60, 70, 80]

    await writeFile(filePath, 'hello\n')

    const rule = defineRule({
      create: () => ({
        onTarget: () => {},
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
        onTarget: async (target) => {
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
        onTarget: async (target) => {
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
        onTarget: (target) => {
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
        onTarget: (target) => {
          if (target.kind !== 'function') {
            return
          }

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
        onTarget: () => {
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
        onTarget: () => {},
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
        onTarget: () => {
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
        onTarget: () => {
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
})
