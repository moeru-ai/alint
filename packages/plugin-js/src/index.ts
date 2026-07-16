import { definePlugin } from '@alint-js/plugin'

import { inlineMiniatureNormalizerRule } from './rules/inline-miniature-normalizer'
import { mixedLayersWithoutAbstractionRule } from './rules/no-mixed-layers-without-abstraction'
import { privateSchemaToolkitRule } from './rules/no-private-schema-toolkit'
import { redundantBindingRule } from './rules/no-redundant-binding'
import { redundantJsdocRule } from './rules/no-redundant-jsdoc'
import { trivialWrapperStackRule } from './rules/no-trivial-wrapper-stack'
import { vacuousFunctionRule } from './rules/no-vacuous-function'

export { createJudgeMessages, createReportFindingsToolParameters, judgeFindingSchema, judgeResponseSchema } from './agents/judge'
export { inlineMiniatureNormalizerRule } from './rules/inline-miniature-normalizer'
export { mixedLayersWithoutAbstractionRule } from './rules/no-mixed-layers-without-abstraction'
export { privateSchemaToolkitRule } from './rules/no-private-schema-toolkit'
export { redundantBindingRule } from './rules/no-redundant-binding'
export { redundantJsdocRule } from './rules/no-redundant-jsdoc'
export { trivialWrapperStackRule } from './rules/no-trivial-wrapper-stack'
export { vacuousFunctionRule } from './rules/no-vacuous-function'

export default definePlugin({
  configs: {
    recommended: [
      {
        rules: {
          'js/inline-miniature-normalizer': 'warn',
          'js/no-mixed-layers-without-abstraction': 'warn',
          'js/no-private-schema-toolkit': 'warn',
          'js/no-redundant-binding': 'warn',
          'js/no-redundant-jsdoc': 'warn',
          'js/no-trivial-wrapper-stack': 'warn',
          'js/no-vacuous-function': 'warn',
        },
      },
    ],
  },
  rules: {
    'inline-miniature-normalizer': inlineMiniatureNormalizerRule,
    'no-mixed-layers-without-abstraction': mixedLayersWithoutAbstractionRule,
    'no-private-schema-toolkit': privateSchemaToolkitRule,
    'no-redundant-binding': redundantBindingRule,
    'no-redundant-jsdoc': redundantJsdocRule,
    'no-trivial-wrapper-stack': trivialWrapperStackRule,
    'no-vacuous-function': vacuousFunctionRule,
  },
})
