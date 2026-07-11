import { definePlugin } from '@alint-js/core'

import { responsibilityBoundaryRule } from './rules/responsibility-boundary'

export {
  collectResponsibilityBoundaryContext,
  createReportFindingsToolParameters,
  createResponsibilityBoundaryMessages,
  reportResponsibilityBoundaryFindings,
  responsibilityBoundaryFindingSchema,
  responsibilityBoundaryPrompt,
  responsibilityBoundaryResponseSchema,
} from './rules/responsibility-boundary'
export { createTools } from '@alint-js/tools-fs'

export function createGoPlugin() {
  return definePlugin({
    configs: {
      example: [
        {
          files: ['**/*.go'],
          language: 'text/plain',
          rules: {
            'go/responsibility-boundary': 'warn',
          },
        },
      ],
    },
    rules: {
      'responsibility-boundary': responsibilityBoundaryRule,
    },
  })
}

export const goPlugin = createGoPlugin()

export default goPlugin
