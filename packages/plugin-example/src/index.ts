import { definePlugin } from '@alint-js/core'

import { inlineMiniatureNormalizerRule } from './rules/inline-miniature-normalizer'
import { privateSchemaToolkitRule } from './rules/no-private-schema-toolkit'
import { redundantBindingRule } from './rules/no-redundant-binding'
import { redundantJsdocRule } from './rules/no-redundant-jsdoc'
import { trivialWrapperStackRule } from './rules/no-trivial-wrapper-stack'

export {
  createJudgeMessages,
  createReportFindingsToolParameters,
  judgeFindingSchema,
  judgeResponseSchema,
} from './agents/judge'
export {
  inlineMiniatureNormalizerPrompt,
  inlineMiniatureNormalizerRule,
} from './rules/inline-miniature-normalizer'
export {
  privateSchemaToolkitPrompt,
  privateSchemaToolkitRule,
} from './rules/no-private-schema-toolkit'
export {
  redundantBindingPrompt,
  redundantBindingRule,
} from './rules/no-redundant-binding'
export {
  redundantJsdocPrompt,
  redundantJsdocRule,
} from './rules/no-redundant-jsdoc'
export {
  trivialWrapperStackPrompt,
  trivialWrapperStackRule,
} from './rules/no-trivial-wrapper-stack'

export const examplePlugin = definePlugin({
  configs: {
    recommended: [
      {
        rules: {
          'example/inline-miniature-normalizer': 'warn',
          'example/no-private-schema-toolkit': 'warn',
          'example/no-redundant-binding': 'warn',
          'example/no-redundant-jsdoc': 'warn',
          'example/no-trivial-wrapper-stack': 'warn',
        },
      },
    ],
  },
  rules: {
    'inline-miniature-normalizer': inlineMiniatureNormalizerRule,
    'no-private-schema-toolkit': privateSchemaToolkitRule,
    'no-redundant-binding': redundantBindingRule,
    'no-redundant-jsdoc': redundantJsdocRule,
    'no-trivial-wrapper-stack': trivialWrapperStackRule,
  },
})

export default examplePlugin
