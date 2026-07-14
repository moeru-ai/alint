import type { ReinventedHelperFinding } from './tools'

import { defineRule } from '@alint-js/core'
import { requireAgent } from '@alint-js/core/agent'

import { buildReinventedHelperPrompt, reinventedHelperInstructions } from './prompt'
import { createReinventedHelperTools } from './tools'

export const reinventedHelperRule = defineRule({
  // Agentic rules read other files and are nondeterministic, so their output is not cacheable.
  cache: false,
  create: ctx => ({
    async onTargetFile(target) {
      if (!target.file.path.endsWith('.ts')) {
        return
      }

      const findings: ReinventedHelperFinding[] = []
      const tools = createReinventedHelperTools(ctx.src, ctx.cwd, findings)
      const model = await ctx.model()
      const agent = requireAgent(ctx)

      await agent({
        instructions: reinventedHelperInstructions,
        model,
        prompt: buildReinventedHelperPrompt(target.file.path, target.file.text),
        tools,
      })

      for (const finding of findings) {
        ctx.report({
          evidence: { suggestion: finding.suggestion },
          filePath: target.file.path,
          loc: { start: { column: 0, line: finding.line } },
          message: finding.message,
        })
      }
    },
  }),
})
