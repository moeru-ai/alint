import { describe, expect, it } from 'vitest'

import {
  ignorePatternsAIAgents,
  ignorePatternsBuildOutputs,
  ignorePatternsCaches,
  ignorePatternsCommon,
  ignorePatternsEslintDefaults,
  ignorePatternsGenerated,
} from './ignore'

describe('ignore pattern presets', () => {
  it('includes ESLint default ignored directories', () => {
    expect(ignorePatternsEslintDefaults).toContain('**/node_modules/**')
    expect(ignorePatternsEslintDefaults).toContain('.git/**')
    expect(ignorePatternsEslintDefaults).toContain('**/.git/**')
  })

  it('groups common generated and transient project files', () => {
    expect(ignorePatternsBuildOutputs).toContain('**/dist/**')
    expect(ignorePatternsCaches).toContain('**/.cache/**')
    expect(ignorePatternsGenerated).toContain('**/__snapshots__/**')
    expect(ignorePatternsAIAgents).toContain('**/.agents/**')
  })

  it('composes common patterns from the reusable groups', () => {
    expect(ignorePatternsCommon).toEqual([
      ...ignorePatternsEslintDefaults,
      ...ignorePatternsBuildOutputs,
      ...ignorePatternsCaches,
      ...ignorePatternsGenerated,
    ])
  })
})
