import { describe, expect, it } from 'vitest'

import { parseSync } from './parser'

describe('js parser', () => {
  it('parses TypeScript source through the local parser boundary', () => {
    const result = parseSync('/project/src/demo.ts', 'const value: number = 1')

    expect(result.program.type).toBe('Program')
    expect(result.errors).toEqual([])
  })
})
