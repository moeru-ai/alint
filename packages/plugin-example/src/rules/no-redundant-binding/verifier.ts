import type { ResolvedModel, RuleContext } from '@alint-js/core'
import type { InferOutput } from 'valibot'

import type { JudgeFinding } from '../../agents/judge/agent'

import { generateStructured } from '@alint-js/core/structured-output'
import { array, boolean, description, number, object, picklist, pipe, string } from 'valibot'

import { createJudgeMessages } from '../../agents/judge/agent'
import { createRedundantBindingVerificationPrompt } from './prompt'

export const verificationDecisionSchema = object({
  boundary: pipe(
    picklist([
      'none',
      'snapshot-or-restoration',
      'receiver',
      'dependency',
      'lifecycle-or-ownership',
      'mutable-work-state',
      'type-or-domain',
      'uncertain',
    ]),
    description('The concrete semantic boundary, or "none" only when no boundary exists.'),
  ),
  confidence: pipe(
    picklist(['high', 'medium', 'low']),
    description('Confidence in this verification decision.'),
  ),
  initializer: pipe(
    picklist([
      'identifier',
      'static-member-access',
      'indexed-or-dynamic',
      'computed-or-constructed',
      'uncertain',
    ]),
    description('Classify the complete initializer. Bracket access belongs to "indexed-or-dynamic", never "static-member-access".'),
  ),
  line: pipe(
    number(),
    description('One candidate declaration line supplied by discovery. Never add another line.'),
  ),
  message: pipe(
    string(),
    description('Explain why the candidate qualifies or which exclusion rejects it.'),
  ),
  safeSubstitution: pipe(
    boolean(),
    description('True only when every use can be replaced by the exact initializer without semantic change.'),
  ),
  suggestion: pipe(
    string(),
    description('For accepted candidates, give a direct-use remediation under 35 words; otherwise briefly state the preserved boundary.'),
  ),
})

export const verificationResponseSchema = pipe(
  object({
    decisions: pipe(
      array(verificationDecisionSchema),
      description('One verification decision per supplied candidate line. Omit no candidate and add no line.'),
    ),
  }),
  description('Strict verification decisions for discovered rebinding candidates.'),
)

type VerificationDecision = InferOutput<typeof verificationDecisionSchema>

interface VerifyOptions {
  candidates: readonly JudgeFinding[]
  logger: RuleContext['logger']
  metering: RuleContext['metering']
  model: ResolvedModel
  outputLanguage?: string
  source: string
}

export function acceptedVerificationDecisions(decisions: readonly VerificationDecision[]): JudgeFinding[] {
  return decisions
    .filter(decision =>
      (decision.initializer === 'identifier' || decision.initializer === 'static-member-access')
      && decision.boundary === 'none'
      && decision.safeSubstitution,
    )
    .map(decision => ({
      confidence: decision.confidence,
      line: decision.line,
      message: decision.message,
      suggestion: decision.suggestion,
    }))
}

export async function verifyRedundantBindings(options: VerifyOptions): Promise<JudgeFinding[]> {
  const { decisions } = await generateStructured({
    createMessages: retryFeedback => createJudgeMessages(
      options.source,
      retryFeedback,
      options.outputLanguage,
      createRedundantBindingVerificationPrompt(options.candidates),
    ),
    logger: options.logger,
    metering: options.metering,
    model: options.model,
    operation: 'redundant-binding-verification',
    schema: verificationResponseSchema,
  })

  return acceptedVerificationDecisions(decisions)
}
