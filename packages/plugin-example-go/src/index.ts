import { definePlugin } from '@alint-js/plugin'

import { duplicatedConversionKnowledgeRule } from './rules/duplicated-conversion-knowledge'
import { noRawSqlBypassingEntRule } from './rules/no-raw-sql-bypassing-ent'
import { privateProtobufToolkitRule } from './rules/private-protobuf-toolkit'
import { responsibilityBoundaryRule } from './rules/responsibility-boundary'

export {
  duplicatedConversionKnowledgeInstructions,
  duplicatedConversionKnowledgePrompt,
  duplicatedConversionKnowledgeRule,
} from './rules/duplicated-conversion-knowledge'
export {
  noRawSqlBypassingEntInstructions,
  noRawSqlBypassingEntPrompt,
  noRawSqlBypassingEntRule,
} from './rules/no-raw-sql-bypassing-ent'
export {
  createPrivateProtobufToolkitMessages,
  privateProtobufToolkitFindingSchema,
  privateProtobufToolkitPrompt,
  privateProtobufToolkitResponseSchema,
  privateProtobufToolkitRule,
} from './rules/private-protobuf-toolkit'
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
            'go/duplicated-conversion-knowledge': 'warn',
            'go/private-protobuf-toolkit': 'warn',
            'go/responsibility-boundary': 'warn',
          },
        },
      ],
    },
    rules: {
      'duplicated-conversion-knowledge': duplicatedConversionKnowledgeRule,
      'no-raw-sql-bypassing-ent': noRawSqlBypassingEntRule,
      'private-protobuf-toolkit': privateProtobufToolkitRule,
      'responsibility-boundary': responsibilityBoundaryRule,
    },
  })
}

export const goPlugin = createGoPlugin()

export default goPlugin
