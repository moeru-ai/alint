import { defineRule } from '@alint-js/core'

import { judgeSource } from '../../agents/judge/agent'
import { createRedundantBindingVerificationPrompt, redundantBindingPrompt } from './prompt'
import { verifyRedundantBindings } from './verifier'

export const redundantBindingRule = defineRule({
  cacheKey: [
    redundantBindingPrompt,
    createRedundantBindingVerificationPrompt([]),
    String(verifyRedundantBindings),
  ],
  create: ctx => ({
    /**
     * Reviews one file target for unchanged local rebinding.
     *
     * Triggering workflow:
     *
     * {@link defineRule}
     *   -> `SourceTarget.kind === "file"`
     *     -> `onTargetFile`
     *       -> {@link judgeSource} / {@link verifyRedundantBindings}
     *
     * Upstream:
     * - {@link defineRule}
     *
     * Downstream:
     * - {@link judgeSource}
     * - {@link verifyRedundantBindings}
     * - `ctx.report`
     */
    async onTargetFile(target) {
      const model = await ctx.model()
      const candidates = await judgeSource({
        logger: ctx.logger,
        metering: ctx.metering,
        model,
        operation: 'redundant-binding-discovery',
        outputLanguage: ctx.outputLanguage,
        prompt: redundantBindingPrompt,
        signal: ctx.signal,
        source: ctx.src.getText(target),
      })

      if (candidates.length === 0) {
        return
      }

      const candidateLines = new Set(candidates.map(candidate => candidate.line))
      const verifiedFindings = await verifyRedundantBindings({
        candidates,
        logger: ctx.logger,
        metering: ctx.metering,
        model,
        outputLanguage: ctx.outputLanguage,
        signal: ctx.signal,
        source: ctx.src.getText(target),
      })
      const reportedLines = new Set<number>()

      for (const finding of verifiedFindings) {
        if (!candidateLines.has(finding.line) || reportedLines.has(finding.line)) {
          continue
        }

        reportedLines.add(finding.line)
        ctx.report({
          evidence: {
            confidence: finding.confidence,
            suggestion: finding.suggestion,
          },
          filePath: target.file.path,
          loc: {
            start: {
              column: 0,
              line: finding.line,
            },
          },
          message: finding.message,
        })
      }
    },
  }),
})
