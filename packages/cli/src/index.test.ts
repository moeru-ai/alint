import { describe, expect, it } from 'vitest'

import { executeCli, formatDiagnostics, formatJson, formatStylish } from './index'

describe('cli package entry', () => {
  it('exports CLI and reporter APIs', () => {
    expect(executeCli).toBeTypeOf('function')
    expect(formatDiagnostics).toBeTypeOf('function')
    expect(formatJson).toBeTypeOf('function')
    expect(formatStylish).toBeTypeOf('function')
  })
})
