import { definePlugin } from '@alint-js/plugin'

import { inlineMiniatureNormalizerRule } from './rules/inline-miniature-normalizer'
import { mixedLayersWithoutAbstractionRule } from './rules/no-mixed-layers-without-abstraction'
import { privateSchemaToolkitRule } from './rules/no-private-schema-toolkit'
import { redundantBindingRule } from './rules/no-redundant-binding'
import { redundantJsdocRule } from './rules/no-redundant-jsdoc'
import { trivialWrapperStackRule } from './rules/no-trivial-wrapper-stack'
import { vacuousFunctionRule } from './rules/no-vacuous-function'

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
  createMixedLayerMessages,
  createMixedLayerReviewMessages,
  createMixedLayerReviewToolParameters,
  createMixedLayerToolParameters,
  mixedLayerFindingSchema,
  mixedLayerResponseSchema,
  mixedLayerReviewDecisionSchema,
  mixedLayerReviewResponseSchema,
  mixedLayersWithoutAbstractionCoveragePerspective,
  mixedLayersWithoutAbstractionOwnershipPerspective,
  mixedLayersWithoutAbstractionPrompt,
  mixedLayersWithoutAbstractionReviewPrompt,
  mixedLayersWithoutAbstractionRule,
  normalizeMixedLayerFindings,
  reportMixedLayerFindings,
  selectReportedMixedLayerFindings,
} from './rules/no-mixed-layers-without-abstraction'
export type {
  MixedLayerFinding,
  MixedLayerReviewDecision,
} from './rules/no-mixed-layers-without-abstraction'
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
export {
  vacuousFunctionPrompt,
  vacuousFunctionRule,
} from './rules/no-vacuous-function'

export const examplePlugin = definePlugin({
  configs: {
    recommended: [
      {
        rules: {
          'example/inline-miniature-normalizer': 'warn',
          'example/no-mixed-layers-without-abstraction': 'warn',
          'example/no-private-schema-toolkit': 'warn',
          'example/no-redundant-binding': 'warn',
          'example/no-redundant-jsdoc': 'warn',
          'example/no-trivial-wrapper-stack': 'warn',
          'example/no-vacuous-function': 'warn',
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

export default examplePlugin
