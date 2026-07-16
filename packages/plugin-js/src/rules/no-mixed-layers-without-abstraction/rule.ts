import type { RuleContext } from '@alint-js/plugin'
import type { JsonSchema } from '@valibot/to-json-schema'
import type { InferOutput } from 'valibot'

import { formatOutputLanguageInstruction, formatSourceWithLineNumbers, toolParametersFromSchema } from '@alint-js/core/structured-output'
import { array, description, number, object, picklist, pipe, string } from 'valibot'

import { mixedLayersWithoutAbstractionPrompt } from './prompt'

const relatedDeclarationSchema = object({
  line: pipe(
    number(),
    description('Left-column line number for a declaration related to the primary finding.'),
  ),
  name: pipe(
    string(),
    description('Declaration name or concise declaration label copied from the reviewed source.'),
  ),
  relationship: pipe(
    string(),
    description('Explain whether this declaration should move with, call through, or stop depending directly on the primary declaration.'),
  ),
})

export const mixedLayerFindingSchema = pipe(
  object({
    boundaryKind: pipe(
      picklist([
        'external-access',
        'low-level-operation',
        'integration-operation',
        'data-adaptation',
        'consumer-policy',
      ]),
      description('The independently evolving integration responsibility owned by this declaration.'),
    ),
    confidence: pipe(
      picklist(['high', 'medium', 'low']),
      description('Confidence in this finding. Use exactly low, medium, or high.'),
    ),
    declaration: pipe(
      string(),
      description('The primary declaration name or concise declaration label copied from the reviewed source.'),
    ),
    line: pipe(
      number(),
      description('Use the primary declaration line from the left column of the numbered source.'),
    ),
    message: pipe(
      string(),
      description('Explain why this declaration participates in an unabstracted external integration stack.'),
    ),
    relatedDeclarations: pipe(
      array(relatedDeclarationSchema),
      description('Declarations that should move with, call through, or stop depending directly on the primary declaration.'),
    ),
    suggestion: pipe(
      string(),
      description('Give a concrete owner and interface direction, cueing related declarations without providing a patch.'),
    ),
  }),
  description('One declaration-level warning for mixed external integration layers without a stable abstraction.'),
)

export const mixedLayerResponseSchema = pipe(
  object({
    findings: pipe(
      array(mixedLayerFindingSchema),
      description('All declaration-level findings. Return an empty array when the file has no qualifying missing boundary.'),
    ),
  }),
  description('Report mixed-layer findings for one JavaScript or TypeScript file.'),
)

export type MixedLayerFinding = InferOutput<typeof mixedLayerFindingSchema>

export function createMixedLayerMessages(
  source: string,
  retryFeedback: string | undefined,
  outputLanguage?: string,
) {
  return [
    {
      content: mixedLayersWithoutAbstractionPrompt,
      role: 'system' as const,
    },
    ...(retryFeedback
      ? [
          {
            content: retryFeedback,
            role: 'user' as const,
          },
        ]
      : []),
    {
      content: [
        formatOutputLanguageInstruction(outputLanguage),
        `Code with line numbers:\n\n${formatSourceWithLineNumbers(source)}`,
      ].filter(Boolean).join('\n\n'),
      role: 'user' as const,
    },
  ]
}

export function createMixedLayerToolParameters(): JsonSchema {
  return toolParametersFromSchema(mixedLayerResponseSchema)
}

export function normalizeMixedLayerFindings(
  findings: readonly MixedLayerFinding[],
  source: string,
): MixedLayerFinding[] {
  const lineCount = source.split('\n').length
  const seenFindingLines = new Set<number>()
  const normalized: MixedLayerFinding[] = []

  for (const finding of findings) {
    if (!validLine(finding.line, lineCount) || seenFindingLines.has(finding.line)) {
      continue
    }

    seenFindingLines.add(finding.line)
    const seenRelationships = new Set<string>()
    const relatedDeclarations = finding.relatedDeclarations.filter((related) => {
      if (!validLine(related.line, lineCount)) {
        return false
      }

      const key = `${related.line}:${related.name}`
      if (seenRelationships.has(key)) {
        return false
      }

      seenRelationships.add(key)
      return true
    })

    normalized.push({ ...finding, relatedDeclarations })
  }

  return normalized
}

export function reportMixedLayerFindings(
  ctx: Pick<RuleContext, 'report'>,
  filePath: string,
  findings: readonly MixedLayerFinding[],
): void {
  for (const finding of findings) {
    ctx.report({
      evidence: {
        boundaryKind: finding.boundaryKind,
        confidence: finding.confidence,
        declaration: finding.declaration,
        relatedDeclarations: finding.relatedDeclarations,
        suggestion: finding.suggestion,
      },
      filePath,
      loc: {
        start: {
          column: 0,
          line: finding.line,
        },
      },
      message: finding.message,
    })
  }
}

function validLine(line: number, lineCount: number): boolean {
  return Number.isInteger(line) && line >= 1 && line <= lineCount
}
