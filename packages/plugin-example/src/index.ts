import { definePlugin } from '@alint-js/core'

import { inlineMiniatureNormalizerRule } from './rules/inline-miniature-normalizer'
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
          'example/no-redundant-jsdoc': 'warn',
          'example/no-trivial-wrapper-stack': 'warn',
        },
      },
    ],
  },
  rules: {
    'inline-miniature-normalizer': inlineMiniatureNormalizerRule,
    'no-redundant-jsdoc': redundantJsdocRule,
    'no-trivial-wrapper-stack': trivialWrapperStackRule,
  },
})

export default examplePlugin
