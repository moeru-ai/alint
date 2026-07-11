import { describe, expect, it } from 'vitest'

import {
  defineConfig,
  executeCli,
  formatDiagnostics,
  formatJson,
  formatStylish,
  ignorePatternsAIAgents,
  ignorePatternsCommon,
} from './index'

describe('cli package entry', () => {
  it('exports CLI and reporter APIs', () => {
    expect(executeCli).toBeTypeOf('function')
    expect(formatDiagnostics).toBeTypeOf('function')
    expect(formatJson).toBeTypeOf('function')
    expect(formatStylish).toBeTypeOf('function')
  })

  it('exports end-user config facade APIs', () => {
    const config = defineConfig([
      {
        ignores: [
          ...ignorePatternsCommon,
          ...ignorePatternsAIAgents,
        ],
        name: 'test/global-ignores',
      },
    ])

    expect(config).toEqual([
      {
        ignores: [
          ...ignorePatternsCommon,
          ...ignorePatternsAIAgents,
        ],
        name: 'test/global-ignores',
      },
    ])
    expect(ignorePatternsCommon).toContain('**/node_modules/**')
    expect(ignorePatternsAIAgents).toContain('**/.agents/**')
  })
})
