import type { LanguageDefinition } from '../../../dsl/types'

import { withLanguage } from '../../source/runtime'
import { extractJsSourceTargets } from '../js/extract'

export const typescriptLanguage: LanguageDefinition = {
  extensions: ['.cts', '.mts', '.ts', '.tsx'],
  extract: file => extractJsSourceTargets(withLanguage(file, 'typescript')),
  name: 'typescript',
}
