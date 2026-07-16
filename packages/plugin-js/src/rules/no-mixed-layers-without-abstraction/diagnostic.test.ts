import type { RuleContext } from '@alint-js/plugin'

import { describe, expect, it } from 'vitest'

import { mixedLayersWithoutAbstractionPrompt } from './prompt'
import { reportMixedLayerFindings } from './rule'

describe('no-mixed-layers-without-abstraction diagnostics', () => {
  it('prints the concrete suggestion in the visible diagnostic message', () => {
    const diagnostics: Parameters<RuleContext['report']>[0][] = []

    reportMixedLayerFindings(
      { report: diagnostic => diagnostics.push(diagnostic) },
      '/repo/source.ts',
      [
        {
          boundaryKind: 'data-adaptation',
          confidence: 'high',
          declaration: 'interpretResponse',
          line: 12,
          message: 'interpretResponse decodes external responses inside the consuming workflow.',
          relatedDeclarations: [
            {
              line: 8,
              name: 'requestExternalData',
              relationship: 'Move with interpretResponse behind the same external integration owner.',
            },
          ],
          suggestion: 'Move requestExternalData and interpretResponse into createExternalDataClient; expose loadInterpretedData(), and update the consumer to call that operation instead of reading raw responses.',
        },
      ],
    )

    expect(diagnostics).toEqual([
      {
        evidence: {
          boundaryKind: 'data-adaptation',
          confidence: 'high',
          declaration: 'interpretResponse',
          relatedDeclarations: [
            {
              line: 8,
              name: 'requestExternalData',
              relationship: 'Move with interpretResponse behind the same external integration owner.',
            },
          ],
          suggestion: 'Move requestExternalData and interpretResponse into createExternalDataClient; expose loadInterpretedData(), and update the consumer to call that operation instead of reading raw responses.',
        },
        filePath: '/repo/source.ts',
        loc: { start: { column: 0, line: 12 } },
        message: [
          'interpretResponse decodes external responses inside the consuming workflow.',
          'Suggestion: Move requestExternalData and interpretResponse into createExternalDataClient; expose loadInterpretedData(), and update the consumer to call that operation instead of reading raw responses.',
        ].join('\n'),
      },
    ])
  })

  it('requires actionable suggestion content in the model prompt', () => {
    expect(mixedLayersWithoutAbstractionPrompt).toContain('Each suggestion must be directly actionable from the warning text alone')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('proposed owner name')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('public operation or result shape')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('caller-side rewrite')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('migration grouping')
    expect(mixedLayersWithoutAbstractionPrompt).toContain('Do not merely restate that layers are mixed')
  })
})
