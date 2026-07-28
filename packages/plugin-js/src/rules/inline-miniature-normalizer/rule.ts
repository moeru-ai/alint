import { defineRule } from '@alint-js/plugin'

import { judgeSource } from '../../agents/judge/agent'
import { inlineMiniatureNormalizerPrompt } from './prompt'

export const inlineMiniatureNormalizerRule = defineRule({
  cacheKey: inlineMiniatureNormalizerPrompt,
  create: ctx => ({
    /**
     * Reviews one planned file for inline miniature normalizers.
     *
     * Triggering workflow:
     *
     * {@link inlineMiniatureNormalizerRule}
     *   -> `RuleHandlers.onTargetFile`
     *     -> {@link judgeSource}
     *
     * Upstream:
     * - {@link inlineMiniatureNormalizerRule}
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
        operation: 'inline-miniature-normalizer-judge',
        outputLanguage: ctx.outputLanguage,
        prompt: inlineMiniatureNormalizerPrompt,
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
