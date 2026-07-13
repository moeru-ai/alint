import { isAbsolute, join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { isPathInside } from './fs'

describe('filesystem path utilities', () => {
  it('accepts an equal path', () => {
    const parent = resolve('root', 'plugins')

    expect(isPathInside(parent, parent)).toBe(true)
  })

  it('accepts child names that begin with two dots', () => {
    const parent = join('root', 'plugins')

    expect(isPathInside(join(parent, '..local'), parent)).toBe(true)
    expect(isPathInside(join(parent, '..foo', 'index.mjs'), parent)).toBe(true)
  })

  it('rejects parent traversal', () => {
    const parent = join('root', 'plugins')

    expect(isPathInside(join(parent, '..', 'outside'), parent)).toBe(false)
  })

  it('rejects a sibling with the same path prefix', () => {
    const parent = resolve('root', 'plugins')

    expect(isPathInside(resolve('root', 'plugins-other'), parent)).toBe(false)
  })

  it('rejects an absolute path outside the parent', () => {
    const parent = resolve('root', 'plugins')
    const outside = resolve('outside', 'plugin')

    expect(isAbsolute(parent)).toBe(true)
    expect(isAbsolute(outside)).toBe(true)
    expect(isPathInside(outside, parent)).toBe(false)
  })
})
