import type { ProjectFileEntry, ProjectTargetEntry } from './index'

import { readFile } from 'node:fs/promises'

import { describe, expect, expectTypeOf, it } from 'vitest'

describe('core public entrypoints', () => {
  it('exports compact project descriptors from the root entrypoint', () => {
    expectTypeOf<keyof ProjectFileEntry>().toEqualTypeOf<'contentHash' | 'language' | 'path' | 'targetCount'>()
    expectTypeOf<keyof ProjectTargetEntry>().toEqualTypeOf<'filePath' | 'identity' | 'kind' | 'name' | 'range'>()
  })

  it('keeps JavaScript language extraction behind a dedicated export', async () => {
    const [rootEntry, packageJsonText] = await Promise.all([
      readFile(new URL('./index.ts', import.meta.url), 'utf8'),
      readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ])
    const packageJson = JSON.parse(packageJsonText) as {
      exports?: Record<string, unknown>
    }

    expect(rootEntry).not.toContain('extractJsSourceTargets')
    expect(packageJson.exports).toHaveProperty('./languages/js')
  })
})
