import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

describe('core public entrypoints', () => {
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
