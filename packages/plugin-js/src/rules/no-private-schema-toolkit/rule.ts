import { defineRule } from '@alint-js/plugin'

import { judgeSource } from '../../agents/judge/agent'
import { privateSchemaToolkitPrompt } from './prompt'

export const privateSchemaToolkitRule = defineRule({
  cacheKey: privateSchemaToolkitPrompt,
  create: ctx => ({
    /**
     * Reviews one planned file for private schema toolkits.
     *
     * Triggering workflow:
     *
     * {@link privateSchemaToolkitRule}
     *   -> `RuleHandlers.onTargetFile`
     *     -> {@link judgeSource}
     *
     * Upstream:
     * - {@link privateSchemaToolkitRule}
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
        operation: 'private-schema-toolkit-judge',
        outputLanguage: ctx.outputLanguage,
        prompt: privateSchemaToolkitPrompt,
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
