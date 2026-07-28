import { defineRule } from '@alint-js/plugin'

import { judgeSource } from '../../agents/judge/agent'
import { redundantJsdocPrompt } from './prompt'

export const redundantJsdocRule = defineRule({
  cacheKey: redundantJsdocPrompt,
  create: ctx => ({
    /**
     * Reviews one planned file for redundant JSDoc.
     *
     * Triggering workflow:
     *
     * {@link redundantJsdocRule}
     *   -> `RuleHandlers.onTargetFile`
     *     -> {@link judgeSource}
     *
     * Upstream:
     * - {@link redundantJsdocRule}
     *
     * Downstream:
     * - {@link judgeSource}
     * - `RuleContext.report`
     */
    async onTargetFile(target) {
      const model = await ctx.model()
      const file = await ctx.src.readFile(target.file)
      const findings = await judgeSource({
        logger: ctx.logger,
        metering: ctx.metering,
        model,
        operation: 'redundant-jsdoc-judge',
        outputLanguage: ctx.outputLanguage,
        prompt: redundantJsdocPrompt,
        signal: ctx.signal,
        source: file.text,
      })

      for (const finding of findings) {
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
