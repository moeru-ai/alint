import type { RuleContext } from '@alint-js/core'
import type { InferOutput } from 'valibot'

import { defineRule } from '@alint-js/core'
import { formatOutputLanguageInstruction, formatSourceWithLineNumbers, generateStructured } from '@alint-js/core/structured-output'
import { array, description, number, object, picklist, pipe, string } from 'valibot'

import { pythonTypedArtifactBoundaryPrompt } from './prompt'

export const pythonTypedArtifactBoundaryFindingSchema = pipe(
  object({
    category: pipe(
      picklist(['typed-artifact-boundary', 'serializer-placement', 'resource-protocol-leak']),
      description('Finding category. Use exactly one of typed-artifact-boundary, serializer-placement, or resource-protocol-leak.'),
    ),
    confidence: pipe(
      picklist(['high', 'medium', 'low']),
      description('Confidence in this finding. Use exactly "low", "medium", or "high" without punctuation.'),
    ),
    line: pipe(
      number(),
      description([
        'Use the left-column line number from the numbered code block.',
        'Pick the first line of the class, dataclass, serializer method, or declaration that best represents the leaked typed artifact boundary.',
      ].join(' ')),
    ),
    message: pipe(
      string(),
      description([
        'Describe the Python typed artifact boundary problem.',
        'Mention the concrete raw artifact, resource dictionary, serializer, or implicit payload protocol being exposed.',
        'Keep the message short.',
      ].join(' ')),
    ),
    relatedDeclarations: pipe(
      array(object({
        line: pipe(
          number(),
          description('Left-column line number for another declaration that participates in the same leaked artifact/result boundary.'),
        ),
        name: pipe(
          string(),
          description('Declaration name or short declaration label from the reviewed source.'),
        ),
        role: pipe(
          string(),
          description('Brief role this declaration plays, such as raw dict field, to_dict serializer, resource aggregation, or downstream dict consumer.'),
        ),
      })),
      description('Related declarations that are evidence for the same leaked artifact/result boundary. Use an empty array when there are no separate supporting declarations.'),
    ),
    suggestion: pipe(
      string(),
      description([
        'Give one concrete design direction.',
        'Prefer typed artifact/resource values and conversion to dictionaries only at the outer serialization edge.',
        'Do not provide a code patch.',
        'Keep the suggestion under 45 words.',
      ].join(' ')),
    ),
  }),
  description('One warning-level report for a Python typed artifact boundary, serializer placement, or resource protocol leak design smell.'),
)

export const pythonTypedArtifactBoundaryResponseSchema = pipe(
  object({
    findings: pipe(
      array(pythonTypedArtifactBoundaryFindingSchema),
      description('All warning-level Python typed artifact boundary findings. Return an empty array when typed results hide artifact/resource protocols appropriately.'),
    ),
  }),
  description('Report Python typed artifact boundary findings for this file.'),
)

type PythonTypedArtifactBoundaryFinding = InferOutput<typeof pythonTypedArtifactBoundaryFindingSchema>

export const pythonTypedArtifactBoundaryRule = defineRule({
  create: ctx => ({
    async onTargetFile(target) {
      if (!target.file.path.endsWith('.py')) {
        return
      }

      const findings = await judgePythonTypedArtifactBoundary(ctx, target.file)

      reportPythonTypedArtifactBoundaryFindings(ctx, target.file.path, findings)
    },
  }),
})

export function createPythonTypedArtifactBoundaryMessages(
  source: string,
  retryFeedback: string | undefined,
  outputLanguage?: string,
) {
  return [
    {
      content: pythonTypedArtifactBoundaryPrompt,
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
        `Python code with line numbers:\n\n${formatSourceWithLineNumbers(source)}`,
      ].filter(Boolean).join('\n\n'),
      role: 'user' as const,
    },
  ]
}

export { pythonTypedArtifactBoundaryPrompt }

export function reportPythonTypedArtifactBoundaryFindings(
  ctx: RuleContext,
  filePath: string,
  findings: readonly PythonTypedArtifactBoundaryFinding[],
): void {
  for (const finding of findings) {
    ctx.report({
      evidence: {
        category: finding.category,
        confidence: finding.confidence,
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

async function judgePythonTypedArtifactBoundary(
  ctx: RuleContext,
  file: { path: string, text: string },
): Promise<PythonTypedArtifactBoundaryFinding[]> {
  const { findings } = await generateStructured({
    createMessages: retryFeedback => createPythonTypedArtifactBoundaryMessages(file.text, retryFeedback, ctx.outputLanguage),
    logger: ctx.logger,
    metering: ctx.metering,
    model: await ctx.model(),
    operation: 'python-typed-artifact-boundary-judge',
    schema: pythonTypedArtifactBoundaryResponseSchema,
  })

  return findings
}
