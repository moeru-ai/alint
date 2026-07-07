import { defineRule } from '@alint-js/core'

import { judgeSource } from '../../agents/judge/agent'
import { inlineMiniatureNormalizerPrompt } from './prompt'

export const inlineMiniatureNormalizerRule = defineRule({
  create: ctx => ({
    async onTarget(target) {
      if (target.kind !== 'file') {
        return
      }

      const model = await ctx.model()
      const findings = await judgeSource({
        logger: ctx.logger,
        metering: ctx.metering,
        model,
        operation: 'inline-miniature-normalizer-judge',
        outputLanguage: ctx.outputLanguage,
        prompt: inlineMiniatureNormalizerPrompt,
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
