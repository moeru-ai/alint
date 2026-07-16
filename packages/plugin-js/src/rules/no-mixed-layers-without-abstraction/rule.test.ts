import { describe, expect, it } from 'vitest'

import { mixedLayersWithoutAbstractionPrompt } from './prompt'

describe('mixedLayersWithoutAbstractionPrompt', () => {
  it('defines reusable integration boundaries without motivating trigger terms', () => {
    expect(mixedLayersWithoutAbstractionPrompt).toContain('external capability')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('stable abstraction')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('relatedDeclarations')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('does not earn an abstraction')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('Do not require a fixed number of layers')

    const normalizedPrompt = mixedLayersWithoutAbstractionPrompt.toLowerCase()
    for (const triggerTerm of [
      'github',
      'gmail',
      'graphql',
      'websocket',
      'formatter',
      'context builder',
    ]) {
      expect(normalizedPrompt).not.toContain(triggerTerm)
    }
  })
})
