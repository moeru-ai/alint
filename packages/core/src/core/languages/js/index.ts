import type { LanguageDefinition } from '../../../dsl/types'

import { withLanguage } from '../../source/runtime'
import { extractJsSourceTargets } from './extract'

export const javascriptLanguage: LanguageDefinition = {
  extensions: ['.cjs', '.js', '.jsx', '.mjs'],
  extract: file => extractJsSourceTargets(withLanguage(file, 'javascript')),
  name: 'javascript',
}
