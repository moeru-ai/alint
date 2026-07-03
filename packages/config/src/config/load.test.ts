import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { loadAlintConfig } from './load'

describe('loadAlintConfig', () => {
  it('loads exported flat config arrays without object defaults', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-config-array-'))
    await writeFile(join(cwd, 'alint.config.ts'), `
export default [
  {
    files: ['**/*.go'],
    rules: { 'review/file': 'warn' },
  },
]
`)

    await mkdir(join(cwd, 'src'))
    const config = await loadAlintConfig(cwd)

    expect(Array.isArray(config)).toBe(true)
    expect(config).toEqual([
      {
        files: ['**/*.go'],
        rules: { 'review/file': 'warn' },
      },
    ])
  })

  it('returns an empty flat config when no config file exists', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'alint-config-missing-'))
    const config = await loadAlintConfig(cwd)

    expect(config).toEqual([])
  })
})
