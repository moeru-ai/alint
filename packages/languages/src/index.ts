import type { LanguageDefinition } from '@alint-js/plugin'

import { withLanguage } from '@alint-js/core'
import { definePlugin } from '@alint-js/plugin'

import { extractTargets } from './extract'

export { extractTargets } from './extract'

export const goLanguage: LanguageDefinition = {
  extensions: ['.go'],
  extract: file => extractTargets(withLanguage(file, 'go')),
  name: 'go',
}

export const pythonLanguage: LanguageDefinition = {
  extensions: ['.py'],
  extract: file => extractTargets(withLanguage(file, 'python')),
  name: 'python',
}

export const rustLanguage: LanguageDefinition = {
  extensions: ['.rs'],
  extract: file => extractTargets(withLanguage(file, 'rust')),
  name: 'rust',
}

/**
 * A plugin that declares languages and nothing else: no rules, no processors.
 *
 * The alias a config registers it under does not matter, because languages register under their own
 * names. Once registered, they serve every plugin's rules, not just this one's.
 */
export const languagesPlugin = definePlugin({
  languages: {
    go: goLanguage,
    python: pythonLanguage,
    rust: rustLanguage,
  },
})

export default languagesPlugin
