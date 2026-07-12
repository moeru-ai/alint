import type { ResolvedModel, RuleContext } from '@alint-js/core'
import type { JsonSchema } from '@valibot/to-json-schema'
import type { InferOutput } from 'valibot'

import { formatOutputLanguageInstruction, formatSourceWithLineNumbers, generateStructured, toolParametersFromSchema } from '@alint-js/core/structured-output'
import { array, description, number, object, picklist, pipe, string } from 'valibot'

export const judgeFindingSchema = pipe(
  object({
    confidence: pipe(
      picklist(['high', 'medium', 'low']),
      description('Confidence in this finding. Use exactly "low", "medium", or "high" without punctuation.'),
    ),
    line: pipe(
      number(),
      description([
        'Use the declaration line of the specific symbol being reported.',
        'Use the left-column line number from the numbered code block.',
        'Do not use a nearby caller line unless that caller is the symbol being reported.',
      ].join(' ')),
    ),
    message: pipe(
      string(),
      description([
        'Mention the specific symbol being reported.',
        'Explain the rule-specific design or readability smell.',
        'Do not list unrelated symbol names in the message.',
        'Keep the message short.',
      ].join(' ')),
    ),
    suggestion: pipe(
      string(),
      description([
        'Provide one concrete remediation direction.',
        'Do not propose a code patch.',
        'Keep the suggestion under 35 words.',
      ].join(' ')),
    ),
  }),
  description('One warning-level report for a rule-specific design or readability smell.'),
)

export const judgeResponseSchema = pipe(
  object({
    findings: pipe(
      array(judgeFindingSchema),
      description('All warning-level findings. Return an empty array when there is no qualifying issue for the current rule.'),
    ),
  }),
  description('Report findings for this TypeScript file.'),
)

export type JudgeFinding = InferOutput<typeof judgeFindingSchema>

interface JudgeSourceOptions {
  logger: RuleContext['logger']
  metering: RuleContext['metering']
  model: ResolvedModel
  operation: string
  outputLanguage?: string
  prompt: string
  source: string
}

export function createJudgeMessages(
  source: string,
  retryFeedback: string | undefined,
  outputLanguage: string | undefined,
  prompt: string,
) {
  return [
    {
      content: prompt,
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

export function createReportFindingsToolParameters(): JsonSchema {
  return toolParametersFromSchema(judgeResponseSchema)
}

export async function judgeSource(
  options: JudgeSourceOptions,
): Promise<JudgeFinding[]> {
  const { findings } = await generateStructured({
    createMessages: retryFeedback => createJudgeMessages(options.source, retryFeedback, options.outputLanguage, options.prompt),
    logger: options.logger,
    metering: options.metering,
    model: options.model,
    operation: options.operation,
    schema: judgeResponseSchema,
  })

  return findings
}
