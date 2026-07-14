import type { RuleContext, SourceTarget } from '@alint-js/core'

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { createBasicStructuredRule, createStructuredMessages, reportDeclarativeFindings } from './basic-structured'

const generateStructuredMock = vi.hoisted(() => vi.fn())

vi.mock('@alint-js/core/structured-output', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@alint-js/core/structured-output')>()

  return {
    ...actual,
    generateStructured: generateStructuredMock,
  }
})

describe('basic-structured declarative preset', () => {
  it('builds messages with instruction, output language, target source, and included files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-structured-messages-'))
    await mkdir(join(root, 'src'), { recursive: true })
    const targetPath = join(root, 'src', 'main.py')
    const helperPath = join(root, 'src', 'helper.py')
    await writeFile(targetPath, 'def main():\n    pass\n')
    await writeFile(helperPath, 'def helper():\n    pass\n')

    const messages = await createStructuredMessages({
      cwd: root,
      includeFiles: ['src/helper.py'],
      instruction: 'Find boundary issues.',
      outputLanguage: '简体中文',
      ruleFilePath: join(root, 'rules', 'rule.alint.toml'),
      sourceText: 'def main():\n    pass\n',
      targetFilePath: targetPath,
    })

    const content = messages.map(message => message.content).join('\n')
    expect(messages[0]).toMatchObject({ role: 'system' })
    expect(content).toContain('Find boundary issues.')
    expect(content).toContain('Write all human-readable finding messages and suggestions in this language: 简体中文.')
    expect(content).toContain('1 | def main():')
    expect(content).toContain('Supplemental files')
    expect(content).toContain('src/helper.py')
    expect(content).toContain('def helper():')
  })

  it('skips oversized supplemental files while keeping small supplemental files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alint-structured-sized-context-'))
    await mkdir(join(root, 'src'), { recursive: true })
    const targetPath = join(root, 'src', 'main.py')
    const helperPath = join(root, 'src', 'helper.py')
    const oversizedPath = join(root, 'src', 'large.py')
    await writeFile(targetPath, 'def main():\n    pass\n')
    await writeFile(helperPath, 'small_helper_marker = True\n')
    await writeFile(oversizedPath, `${'x'.repeat(65 * 1024)}oversized_marker\n`)

    const messages = await createStructuredMessages({
      cwd: root,
      includeFiles: ['src/*.py'],
      instruction: 'Find boundary issues.',
      ruleFilePath: join(root, 'rules', 'rule.alint.toml'),
      sourceText: 'def main():\n    pass\n',
      targetFilePath: targetPath,
    })

    const content = messages.map(message => message.content).join('\n')
    expect(content).toContain('small_helper_marker')
    expect(content).not.toContain('oversized_marker')
  })

  it('maps findings to diagnostics and filters out-of-scope files', () => {
    const reports: unknown[] = []
    const ctx = {
      cwd: '/repo',
      logger: { debug: vi.fn() },
      report: (diagnostic: unknown) => reports.push(diagnostic),
    }

    reportDeclarativeFindings({
      ctx,
      excludeFiles: ['**/*_test.py'],
      findings: [
        { confidence: 'high', filePath: '/repo/src/main.py', line: 2, message: 'move parser', suggestion: 'Create a parser object.' },
        { filePath: '/repo/src/main_test.py', line: 1, message: 'ignored test file' },
      ],
      includeFiles: ['src/**/*.py'],
      targetFilePath: '/repo/src/main.py',
    })

    expect(reports).toEqual([
      {
        evidence: {
          confidence: 'high',
          suggestion: 'Create a parser object.',
        },
        filePath: '/repo/src/main.py',
        loc: { start: { column: 0, line: 2 } },
        message: 'move parser',
      },
    ])
    expect(ctx.logger.debug).toHaveBeenCalledOnce()
  })

  it('creates a cacheable file-target rule without included supplemental files', () => {
    const rule = createBasicStructuredRule({
      builtInAgent: 'basic-structured',
      excludeFiles: [],
      filePath: '/repo/rules/semantic/rule.alint.toml',
      instruction: 'Find semantic boundary issues.',
      name: 'semantic-boundary',
    })

    expect(rule.cache).toBe(true)
    expect(rule.create).toEqual(expect.any(Function))
    expect(rule.create(createRuleContext()).onTargetFile).toEqual(expect.any(Function))
  })

  it('creates a non-cacheable file-target rule with included supplemental files', () => {
    const rule = createBasicStructuredRule({
      builtInAgent: 'basic-structured',
      excludeFiles: [],
      filePath: '/repo/rules/semantic/rule.alint.toml',
      includeFiles: ['src/**/*.py'],
      instruction: 'Find semantic boundary issues.',
      name: 'semantic-boundary',
    })

    expect(rule.cache).toBe(false)
    expect(rule.create).toEqual(expect.any(Function))
    expect(rule.create(createRuleContext()).onTargetFile).toEqual(expect.any(Function))
  })

  it('runs structured output for a file target', async () => {
    generateStructuredMock.mockResolvedValueOnce({
      findings: [
        {
          line: 1,
          message: 'use a clearer boundary',
        },
      ],
    })

    const ctx = createRuleContext()
    const rule = createBasicStructuredRule({
      builtInAgent: 'basic-structured',
      excludeFiles: [],
      filePath: '/repo/rules/semantic/rule.alint.toml',
      instruction: 'Find semantic boundary issues.',
      name: 'semantic-boundary',
    })

    await rule.create(ctx).onTargetFile?.(createTarget('file'))

    expect(ctx.model).toHaveBeenCalledOnce()
    expect(generateStructuredMock).toHaveBeenCalledOnce()
    expect(ctx.report).toHaveBeenCalledWith({
      filePath: '/repo/src/main.py',
      loc: { start: { column: 0, line: 1 } },
      message: 'use a clearer boundary',
    })
  })
})

function createRuleContext(): RuleContext {
  return {
    cwd: '/repo',
    id: 'declarative/semantic-boundary',
    localId: 'semantic-boundary',
    logger: { debug: vi.fn() },
    metering: { recordUsage: vi.fn() },
    model: vi.fn(async () => ({
      aliases: [],
      capabilities: ['structured-output'],
      id: 'test-model',
      name: 'Test Model',
      params: {},
      provider: {
        endpoint: 'https://example.test/v1',
        headers: {},
        id: 'test-provider',
        type: 'openai-compatible' as const,
      },
    })),
    report: vi.fn(),
    settings: {},
    src: {
      getText: source => source.text,
      readFile: async filePath => ({
        language: 'python',
        lines: [''],
        path: filePath,
        text: '',
      }),
      sliceLines: (file, range) => ({
        filePath: file.path,
        loc: {
          end: { column: 0, line: range.endLine },
          start: { column: 0, line: range.startLine },
        },
        text: file.lines.slice(range.startLine - 1, range.endLine).join('\n'),
      }),
      sliceRange: (file, range) => ({
        filePath: file.path,
        loc: {
          end: { column: range.end, line: 1 },
          start: { column: range.start, line: 1 },
        },
        text: file.text.slice(range.start, range.end),
      }),
    },
  }
}

function createTarget<Kind extends SourceTarget['kind']>(kind: Kind): SourceTarget & { kind: Kind } {
  return {
    file: {
      language: 'python',
      lines: ['print("hello")', ''],
      path: '/repo/src/main.py',
      text: 'print("hello")\n',
    },
    identity: `${kind}:main`,
    kind,
    language: 'python',
    text: 'print("hello")\n',
  }
}
