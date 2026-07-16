import type { GenerateStructuredOptions } from '@alint-js/core/structured-output'
import type { FileTarget, RuleContext } from '@alint-js/plugin'
import type { JsonSchema } from '@valibot/to-json-schema'
import type { InferOutput } from 'valibot'

import { formatOutputLanguageInstruction, formatSourceWithLineNumbers, generateStructured, toolParametersFromSchema } from '@alint-js/core/structured-output'
import { defineRule } from '@alint-js/plugin'
import { array, description, number, picklist, pipe, strictObject, string } from 'valibot'

import {
  mixedLayersWithoutAbstractionPrompt,
  mixedLayersWithoutAbstractionReviewPrompt,
} from './prompt'

const relatedDeclarationSchema = strictObject({
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
  strictObject({
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
  strictObject({
    findings: pipe(
      array(mixedLayerFindingSchema),
      description('All declaration-level findings. Return an empty array when the file has no qualifying missing boundary.'),
    ),
  }),
  description('Report mixed-layer findings for one JavaScript or TypeScript file.'),
)

export const mixedLayerReviewDecisionSchema = strictObject({
  decision: pipe(
    picklist(['report', 'suppress']),
    description('Whether this finding should produce a diagnostic. Use exactly report or suppress.'),
  ),
  finding: mixedLayerFindingSchema,
  reason: pipe(
    string(),
    description('Explain why the source evidence requires reporting or suppressing this finding.'),
  ),
})

export const mixedLayerReviewResponseSchema = pipe(
  strictObject({
    decisions: pipe(
      array(mixedLayerReviewDecisionSchema),
      description('Explicit report or suppress decisions for all draft candidates and reviewer-added declarations.'),
    ),
  }),
  description('Make final report or suppress decisions for mixed-layer findings in one JavaScript or TypeScript file.'),
)

export type MixedLayerFinding = InferOutput<typeof mixedLayerFindingSchema>
export type MixedLayerReviewDecision = InferOutput<typeof mixedLayerReviewDecisionSchema>

type GenerateMixedLayerDraft = (
  options: GenerateStructuredOptions<typeof mixedLayerResponseSchema>,
) => Promise<InferOutput<typeof mixedLayerResponseSchema>>

type GenerateMixedLayerReview = (
  options: GenerateStructuredOptions<typeof mixedLayerReviewResponseSchema>,
) => Promise<InferOutput<typeof mixedLayerReviewResponseSchema>>

interface MixedLayerRuleDependencies {
  generateDraft: GenerateMixedLayerDraft
  generateReview: GenerateMixedLayerReview
}

const defaultMixedLayerRuleDependencies: MixedLayerRuleDependencies = {
  generateDraft: generateStructured,
  generateReview: generateStructured,
}

export function createMixedLayersWithoutAbstractionRule(
  dependencies: MixedLayerRuleDependencies = defaultMixedLayerRuleDependencies,
) {
  return defineRule({
    cacheKey: [
      mixedLayersWithoutAbstractionPrompt,
      mixedLayersWithoutAbstractionReviewPrompt,
      'mixed-layer-findings-v4',
    ],
    create: (ctx) => {
      /**
       * Reviews one file target for integration responsibilities that lack a stable owner.
       *
       * Triggering workflow:
       *
       * `createSourceTargetExecution`
       *   -> `RuleHandlers.onTargetFile`
       *     -> {@link onTargetFile}
       *       -> `mixed-layers-without-abstraction-draft-1`
       *         -> `mixed-layers-without-abstraction-draft-2`
       *           -> `mixed-layers-without-abstraction-review`
       *             -> {@link selectReportedMixedLayerFindings}
       *               -> {@link reportMixedLayerFindings}
       *
       * Upstream:
       * - `createSourceTargetExecution` in `packages/core/src/core/targets/source.ts`
       *
       * Downstream:
       * - {@link generateStructured} -> first draft sample
       * - {@link generateStructured} -> second draft sample
       * - {@link generateStructured} -> final report or suppress decisions
       * - {@link selectReportedMixedLayerFindings} -> reportable findings
       * - {@link reportMixedLayerFindings} -> `RuleContext.report`
       */
      async function onTargetFile(target: FileTarget): Promise<void> {
        const model = await ctx.model()
        const source = ctx.src.getText(target)
        const firstDraft = await dependencies.generateDraft({
          createMessages: retryFeedback => createMixedLayerMessages(
            source,
            retryFeedback,
            ctx.outputLanguage,
          ),
          logger: ctx.logger,
          metering: ctx.metering,
          model,
          operation: 'mixed-layers-without-abstraction-draft-1',
          schema: mixedLayerResponseSchema,
          signal: ctx.signal,
        })
        const secondDraft = await dependencies.generateDraft({
          createMessages: retryFeedback => createMixedLayerMessages(
            source,
            retryFeedback,
            ctx.outputLanguage,
          ),
          logger: ctx.logger,
          metering: ctx.metering,
          model,
          operation: 'mixed-layers-without-abstraction-draft-2',
          schema: mixedLayerResponseSchema,
          signal: ctx.signal,
        })
        const review = await dependencies.generateReview({
          createMessages: retryFeedback => createMixedLayerReviewMessages(
            source,
            firstDraft.findings,
            secondDraft.findings,
            retryFeedback,
            ctx.outputLanguage,
          ),
          logger: ctx.logger,
          metering: ctx.metering,
          model,
          operation: 'mixed-layers-without-abstraction-review',
          schema: mixedLayerReviewResponseSchema,
          signal: ctx.signal,
        })

        reportMixedLayerFindings(
          ctx,
          target.file.path,
          normalizeMixedLayerFindings(
            selectReportedMixedLayerFindings(review.decisions),
            source,
          ),
        )
      }

      return { onTargetFile }
    },
  })
}

export const mixedLayersWithoutAbstractionRule = createMixedLayersWithoutAbstractionRule()

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

export function createMixedLayerReviewMessages(
  source: string,
  firstDraftFindings: readonly MixedLayerFinding[],
  secondDraftFindings: readonly MixedLayerFinding[],
  retryFeedback: string | undefined,
  outputLanguage?: string,
) {
  return [
    {
      content: mixedLayersWithoutAbstractionReviewPrompt,
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
        `Draft sample 1 (candidate recall only):\n\n${renderMixedLayerDraft(firstDraftFindings)}`,
        `Draft sample 2 (candidate recall only):\n\n${renderMixedLayerDraft(secondDraftFindings)}`,
      ].filter(Boolean).join('\n\n'),
      role: 'user' as const,
    },
  ]
}

export function createMixedLayerReviewToolParameters(): JsonSchema {
  return toolParametersFromSchema(mixedLayerReviewResponseSchema)
}

export function createMixedLayerToolParameters(): JsonSchema {
  return toolParametersFromSchema(mixedLayerResponseSchema)
}

export function normalizeMixedLayerFindings(
  findings: readonly MixedLayerFinding[],
  source: string,
): MixedLayerFinding[] {
  const lineCount = source.split('\n').length
  const seenFindingIdentities = new Set<string>()
  const normalized: MixedLayerFinding[] = []

  for (const finding of findings) {
    const identity = `${finding.line}:${finding.declaration}`
    if (!validLine(finding.line, lineCount) || seenFindingIdentities.has(identity)) {
      continue
    }

    seenFindingIdentities.add(identity)
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

export function selectReportedMixedLayerFindings(
  decisions: readonly MixedLayerReviewDecision[],
): MixedLayerFinding[] {
  return decisions
    .filter(decision => decision.decision === 'report')
    .map(decision => decision.finding)
}

function renderMixedLayerDraft(findings: readonly MixedLayerFinding[]): string {
  return JSON.stringify({
    findings: findings.map(finding => ({
      boundaryKind: finding.boundaryKind,
      confidence: finding.confidence,
      declaration: finding.declaration,
      line: finding.line,
      message: finding.message,
      relatedDeclarations: finding.relatedDeclarations.map(related => ({
        line: related.line,
        name: related.name,
        relationship: related.relationship,
      })),
      suggestion: finding.suggestion,
    })),
  }, null, 2)
}

function validLine(line: number, lineCount: number): boolean {
  return Number.isInteger(line) && line >= 1 && line <= lineCount
}
