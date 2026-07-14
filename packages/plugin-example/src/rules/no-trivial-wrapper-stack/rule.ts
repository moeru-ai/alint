import { defineRule } from '@alint-js/core'

import { judgeSource } from '../../agents/judge/agent'
import { trivialWrapperStackPrompt } from './prompt'

export const trivialWrapperStackRule = defineRule({
  cacheKey: trivialWrapperStackPrompt,
  create: ctx => ({
    async onTargetFile(target) {
      const model = await ctx.model()
      const findings = await judgeSource({
        logger: ctx.logger,
        metering: ctx.metering,
        model,
        operation: 'trivial-wrapper-stack-judge',
        outputLanguage: ctx.outputLanguage,
        prompt: trivialWrapperStackPrompt,
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
