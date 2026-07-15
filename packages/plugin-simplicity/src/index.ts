import { definePlugin } from '@alint-js/plugin'

import { duplicatedHelperRule } from './rules/no-duplicated-helper'
import { needlessHelperRule } from './rules/no-needless-helper'

export type { CallSite, ExtractedFunction, ExtractLanguage, SourceExtract } from './extract'
export { extractSource, resolveExtractLanguage } from './extract'
export { alphaFingerprint, exactFingerprint, normalizedBody, tokenize, tokenOverlap } from './fingerprint'
export type { IndexedHelper, RepoIndex, RepoIndexOptions, ReviewCache } from './repo'
export { helpersIn, repoIndexFor, reviewCacheFor, twinsOf } from './repo'
export type { AgentFinding, DuplicateToolsOptions } from './rules/no-duplicated-helper'
export {
  buildDuplicatedHelperPrompt,
  createDuplicateTools,
  duplicatedHelperInstructions,
  duplicatedHelperRule,
} from './rules/no-duplicated-helper'
export {
  buildNeedlessHelperPrompt,
  needlessHelperPrompt,
  needlessHelperResponseSchema,
  needlessHelperRule,
} from './rules/no-needless-helper'
export type { SimplicitySettings } from './rules/shared/settings'

export const simplicityPlugin = definePlugin({
  configs: {
    /*
     * The rule ids carry the `simplicity/` prefix, so the preset only resolves when the plugin
     * is registered under that alias. Both rules need a model, except `no-duplicated-helper`'s
     * AST approach; set `settings.simplicity.judge` to false to keep only that.
     */
    recommended: [
      {
        files: ['**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs,rs,go,py}'],
        language: 'text/plain',
        rules: {
          'simplicity/no-duplicated-helper': 'warn',
          'simplicity/no-needless-helper': 'warn',
        },
      },
    ],
  },
  rules: {
    'no-duplicated-helper': duplicatedHelperRule,
    'no-needless-helper': needlessHelperRule,
  },
})

export default simplicityPlugin
