import { describe, expect, it } from 'vitest'

import { mixedLayersWithoutAbstractionPrompt } from './prompt'

describe('mixedLayersWithoutAbstractionPrompt', () => {
  it('defines reusable integration boundaries without motivating trigger terms', () => {
    expect(mixedLayersWithoutAbstractionPrompt).toContain('external capability')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('stable abstraction')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('relatedDeclarations')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('does not earn an abstraction')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('Do not require a fixed number of layers')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('at least two responsibilities')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('embedded in a consuming feature')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('report every primary declaration')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('a focused integration module')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('a simple one-off external call')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('shallow wrappers')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('Suppress a finding when the evidence does not establish a reusable missing boundary')

    const normalizedPrompt = mixedLayersWithoutAbstractionPrompt.toLowerCase()
    for (const triggerTerm of [
      'github',
      'gmail',
      'graphql',
      'websocket',
      'formatter',
      'context builder',
      'context-builder',
    ]) {
      expect(normalizedPrompt).not.toContain(triggerTerm)
    }
  })
})
