import { defineRule } from '@alint-js/core'

import { judgeSource } from '../../agents/judge/agent'
import { privateSchemaToolkitPrompt } from './prompt'

export const privateSchemaToolkitRule = defineRule({
  cacheKey: privateSchemaToolkitPrompt,
  create: ctx => ({
    async onTargetFile(target) {
      const model = await ctx.model()
      const findings = await judgeSource({
        logger: ctx.logger,
        metering: ctx.metering,
        model,
        operation: 'private-schema-toolkit-judge',
        outputLanguage: ctx.outputLanguage,
        prompt: privateSchemaToolkitPrompt,
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
