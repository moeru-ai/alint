import { defineRule } from '@alint-js/plugin'

import { judgeSource } from '../../agents/judge/agent'
import { vacuousFunctionPrompt } from './prompt'

export const vacuousFunctionRule = defineRule({
  cacheKey: vacuousFunctionPrompt,
  create: ctx => ({
    /**
     * Reviews one file target for functions that do not earn a separate boundary.
     *
     * Triggering workflow:
     *
     * {@link defineRule}
     *   -> `SourceTarget.kind === "file"`
     *     -> `onTargetFile`
     *       -> {@link judgeSource}
     *
     * Upstream:
     * - {@link defineRule}
     *
     * Downstream:
     * - {@link judgeSource}
     * - `ctx.report`
     */
    async onTargetFile(target) {
      const model = await ctx.model()
      const findings = await judgeSource({
        logger: ctx.logger,
        metering: ctx.metering,
        model,
        operation: 'vacuous-function-judge',
        outputLanguage: ctx.outputLanguage,
        prompt: vacuousFunctionPrompt,
        signal: ctx.signal,
        source: ctx.src.getText(target),
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
