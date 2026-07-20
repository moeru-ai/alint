import type { SyntaxNode } from '../../agents/syntax'

import { defineRule } from '@alint-js/plugin'

import { reviewRepository } from '../../agents/repository-review'
import { isSyntaxNode, parseProgram, sourceLinesForNodes, visitSyntax } from '../../agents/syntax'
import {
  redundantCatchInstructions,
  redundantCatchPrompt,
  redundantCatchVerificationPrompt,
} from './prompt'

const REDUNDANT_CATCH_CATEGORIES = ['redundant-catch'] as const

export const redundantCatchRule = defineRule({
  cache: false,
  create: ctx => ({
    async onTargetFile(target) {
      const source = ctx.src.getText(target)
      const candidates = findCatchCandidates(target.file.path, source)

      if (candidates.length === 0) {
        return
      }

      const candidatePrompt = formatCandidatePrompt(candidates)
      let findings = await reviewRepository(ctx, target, {
        allowedCategories: REDUNDANT_CATCH_CATEGORIES,
        instructions: redundantCatchInstructions,
        operation: 'redundant-catch-review',
        prompt: `${redundantCatchPrompt}\n\n${candidatePrompt}`,
        requireRelatedLocations: true,
      })

      if (findings.length === 0) {
        findings = await reviewRepository(ctx, target, {
          allowedCategories: REDUNDANT_CATCH_CATEGORIES,
          instructions: redundantCatchInstructions,
          operation: 'redundant-catch-verification',
          prompt: `${redundantCatchVerificationPrompt}\n\n${candidatePrompt}`,
          requireRelatedLocations: true,
        })
      }

      for (const finding of findings) {
        ctx.report({
          evidence: {
            category: finding.category,
            ...(finding.futureFailure ? { futureFailure: finding.futureFailure } : {}),
            proof: finding.proof,
            relatedLocations: finding.relatedLocations,
            suggestion: finding.suggestion,
          },
          filePath: target.file.path,
          loc: { start: { column: 0, line: finding.line } },
          message: finding.message,
        })
      }
    },
  }),
})

function findCatchCandidates(filePath: string, source: string): { line: number, text: string }[] {
  const program = parseProgram(filePath, source)

  if (!program) {
    return []
  }

  const catchRegions: SyntaxNode[] = []

  visitSyntax(program, (node) => {
    if (node.type === 'TryStatement' && isSyntaxNode(node.handler) && node.handler.type === 'CatchClause') {
      catchRegions.push(node)
    }
  })

  return sourceLinesForNodes(source, catchRegions)
}

function formatCandidatePrompt(candidates: readonly { line: number, text: string }[]): string {
  return [
    'The following target catch candidate syntax was extracted mechanically. It is evidence to investigate, not a conclusion:',
    JSON.stringify(candidates),
  ].join('\n')
}
