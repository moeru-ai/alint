import type { LanguageDefinition, PluginDefinition } from '../../dsl/types'
import type { SourceRuntime, SourceTarget } from './types'

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { defineConfig, definePlugin, defineRule } from '../../dsl/define'
import { runAlint } from '../run'
import { createSourceRuntime } from './runtime'

/*
 * `src.extract` parses files the run was never asked to lint — what `onTargetProject` and any index
 * builder needs, and what forced plugins to carry private parsers before.
 *
 * Every case reaches it the way a rule does: through a real run, from inside a handler, so the
 * config resolution and the language registry are the run's own rather than a stand-in.
 *
 * The linted file is always a `.txt`, extracted by the built-in text language. That keeps the
 * counting languages below untouched by the run's own per-file extraction, so a parse count is
 * `src.extract`'s alone.
 */

interface CountingLanguage {
  language: LanguageDefinition
  parses: () => number
}

/** Counts extractions, so memoization is observable rather than assumed. */
function countingLanguage(name: string, extensions: string[] = ['.custom']): CountingLanguage {
  let parses = 0

  return {
    language: {
      extensions,
      extract: (file) => {
        parses += 1

        return [{
          file,
          identity: 'file',
          kind: 'file',
          language: name,
          metadata: { parses },
          origin: { physicalPath: file.path },
          text: file.text,
        }]
      },
      name,
    },
    parses: () => parses,
  }
}

/** Runs `use` inside a rule handler, where `ctx.src` is the run's own wired runtime. */
async function withRuleContext(
  options: {
    cwd: string
    ignores?: string[]
    /** Overrides the `.txt` the run lints, for a case that needs the linted file to be the parsed one. */
    lints?: string
    plugin: PluginDefinition
  },
  use: (src: SourceRuntime) => Promise<void>,
): Promise<void> {
  const linted = options.lints ?? join(options.cwd, 'probe.txt')

  if (options.lints === undefined) {
    await writeFile(linted, 'probe\n')
  }

  let failure: unknown
  let ran = false

  const rule = defineRule({
    create: ctx => ({
      onTargetFile: async () => {
        ran = true

        try {
          await use(ctx.src)
        }
        catch (error) {
          // A throwing handler becomes a run failure, which surfaces as a diagnostic rather than a
          // test failure. Carried out so the assertion inside `use` is the one that reports.
          failure = error
        }
      },
    }),
  })

  await runAlint({
    config: defineConfig([
      {
        plugins: {
          company: definePlugin({ ...options.plugin, rules: { probe: rule } }),
        },
        rules: { 'company/probe': 'warn' },
      },
      ...(options.ignores ? [{ ignores: options.ignores }] : []),
    ]),
    cwd: options.cwd,
    files: [linted],
    runner: { cache: false },
    setupConfig: { providers: [], version: 1 },
  })

  expect(ran).toBe(true)

  if (failure !== undefined) {
    throw failure
  }
}

describe('src.extract', () => {
  it('extracts a file the run was not asked to lint, through that file\'s own config', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-extract-'))
    const unlinted = join(cwd, 'unlinted.custom')

    await writeFile(unlinted, 'unlinted\n')

    const { language } = countingLanguage('custom/plain')
    let targets: SourceTarget[] = []

    await withRuleContext(
      { cwd, plugin: { languages: { custom: language } } },
      async (src) => {
        targets = await src.extract(unlinted)
      },
    )

    expect(targets).toHaveLength(1)
    expect(targets[0].language).toBe('custom/plain')
    expect(targets[0].text).toBe('unlinted\n')
  })

  it('resolves through a language the config\'s plugins registered, not just the built-ins', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-extract-plugin-'))
    const other = join(cwd, 'other.custom')

    await writeFile(other, 'other\n')

    const { language } = countingLanguage('company/custom')
    let targets: SourceTarget[] = []

    await withRuleContext(
      { cwd, plugin: { languages: { custom: language } } },
      async (src) => {
        targets = await src.extract(other)
      },
    )

    // Without the plugin's language `.custom` belongs to nobody and would have been plain text.
    expect(targets[0].language).toBe('company/custom')
  })

  it('returns nothing for an ignored file rather than throwing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-extract-ignored-'))
    const ignored = join(cwd, 'vendor.custom')

    await writeFile(ignored, 'ignored\n')

    const { language, parses } = countingLanguage('custom/plain')
    let targets: SourceTarget[] = []

    await withRuleContext(
      {
        cwd,
        ignores: ['vendor.custom'],
        plugin: { languages: { custom: language } },
      },
      async (src) => {
        targets = await src.extract(ignored)
      },
    )

    expect(targets).toStrictEqual([])
    // Not parsed just to be thrown away.
    expect(parses()).toBe(0)
  })

  it('honours an explicit language over the extension it would resolve to', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-extract-override-'))
    const mystery = join(cwd, 'notes.unknown')

    await writeFile(mystery, 'mystery\n')

    const { language } = countingLanguage('custom/plain')
    let pinned: SourceTarget[] = []
    let fallback: SourceTarget[] = []

    await withRuleContext(
      { cwd, plugin: { languages: { custom: language } } },
      async (src) => {
        pinned = await src.extract(mystery, { language: 'custom/plain' })
        fallback = await src.extract(mystery)
      },
    )

    expect(pinned[0].language).toBe('custom/plain')
    // Same file, no pin: `.unknown` belongs to nobody, so it is plain text.
    expect(fallback[0].language).toBe('text/plain')
  })

  it('honours an explicit language over the config\'s own pin', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-extract-pin-'))
    const other = join(cwd, 'other.custom')

    await writeFile(other, 'other\n')

    const { language, parses } = countingLanguage('custom/plain')
    let pinned: SourceTarget[] = []

    await withRuleContext(
      { cwd, plugin: { languages: { custom: language } } },
      async (src) => {
        pinned = await src.extract(other, { language: 'text/plain' })
      },
    )

    expect(pinned[0].language).toBe('text/plain')
    // The pin wins outright: the language `.custom` resolves to never runs.
    expect(parses()).toBe(0)
  })

  it('parses a file once however many times it is asked for', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-extract-memo-'))
    const other = join(cwd, 'other.custom')

    await writeFile(other, 'other\n')

    const { language, parses } = countingLanguage('custom/plain')
    let first: SourceTarget[] = []
    let second: SourceTarget[] = []

    await withRuleContext(
      { cwd, plugin: { languages: { custom: language } } },
      async (src) => {
        first = await src.extract(other)
        second = await src.extract(other)
      },
    )

    expect(parses()).toBe(1)
    expect(first[0]).toBe(second[0])
  })

  it('shares the run\'s own parse of a linted file rather than parsing it again', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-extract-linted-'))
    const linted = join(cwd, 'linted.custom')

    await writeFile(linted, 'linted\n')

    const { language, parses } = countingLanguage('custom/plain')
    let targets: SourceTarget[] = []

    await withRuleContext(
      { cwd, lints: linted, plugin: { languages: { custom: language } } },
      async (src) => {
        targets = await src.extract(linted)
      },
    )

    // The run parsed it to build the targets the handler was called with; an index builder asking
    // for the same file is answered from that, which is the whole point of one memo for both paths.
    expect(parses()).toBe(1)
    expect(targets[0].text).toBe('linted\n')
  })

  it('keeps one answer per language, so two pins for one file do not collide', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-extract-two-pins-'))
    const other = join(cwd, 'other.custom')

    await writeFile(other, 'other\n')

    const byExtension = countingLanguage('custom/plain')
    // No extensions: reachable only by an explicit pin, which is the whole point of the override.
    const byPin = countingLanguage('custom/alternate', [])

    await withRuleContext(
      {
        cwd,
        plugin: { languages: { alternate: byPin.language, custom: byExtension.language } },
      },
      async (src) => {
        expect((await src.extract(other))[0].language).toBe('custom/plain')
        expect((await src.extract(other, { language: 'custom/alternate' }))[0].language).toBe('custom/alternate')

        // Both pins again: each memoized separately, neither re-parses.
        await src.extract(other)
        await src.extract(other, { language: 'custom/alternate' })
      },
    )

    expect(byExtension.parses()).toBe(1)
    expect(byPin.parses()).toBe(1)
  })

  it('re-parses a file whose text changed under it', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-extract-rewrite-'))
    const other = join(cwd, 'other.custom')

    await writeFile(other, 'before\n')

    const { language, parses } = countingLanguage('custom/plain')

    await withRuleContext(
      { cwd, plugin: { languages: { custom: language } } },
      async (src) => {
        expect((await src.extract(other))[0].text).toBe('before\n')

        await writeFile(other, 'after\n')

        // Memoized on the text, not just the path: an index builder outlives an edit to a file it
        // already read.
        expect((await src.extract(other))[0].text).toBe('after\n')
      },
    )

    expect(parses()).toBe(2)
  })
})

describe('a source runtime built outside a run', () => {
  it('has no extractor, and says so rather than guessing a language', async () => {
    const src = createSourceRuntime()

    await expect(src.extract('/tmp/anything.ts')).rejects.toThrow(
      /this source runtime was created without an extractor/,
    )
  })

  it('still reads and slices, which is all a language asks of it', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-extract-unwired-'))
    const path = join(cwd, 'plain.txt')

    await writeFile(path, 'first\nsecond\n')

    const src = createSourceRuntime()
    const file = await src.readFile(path)

    expect(src.getText(file)).toBe('first\nsecond\n')
    expect(src.sliceLines(file, { endLine: 1, startLine: 1 }).text).toBe('first')
  })
})
