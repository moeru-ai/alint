import { defineRule } from '@alint-js/plugin'

import { judgeSource } from '../../agents/judge/agent'
import { trivialWrapperStackPrompt } from './prompt'

export const trivialWrapperStackRule = defineRule({
  cacheKey: trivialWrapperStackPrompt,
  create: ctx => ({
    /**
     * Reviews one planned file for trivial wrapper stacks.
     *
     * Triggering workflow:
     *
     * {@link trivialWrapperStackRule}
     *   -> `RuleHandlers.onTargetFile`
     *     -> {@link judgeSource}
     *
     * Upstream:
     * - {@link trivialWrapperStackRule}
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
        operation: 'trivial-wrapper-stack-judge',
        outputLanguage: ctx.outputLanguage,
        prompt: trivialWrapperStackPrompt,
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
