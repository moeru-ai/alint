import type { LanguageDefinition } from '../../../dsl/types'
import type { SourceFile } from '../../source/types'

import { extractJsSourceTargets } from '../js/extract'

export const typescriptLanguage: LanguageDefinition = {
  extensions: ['.cts', '.mts', '.ts', '.tsx'],
  extract: file => extractJsSourceTargets(withLanguage(file, 'typescript')),
  name: 'typescript',
}

function withLanguage(file: SourceFile, language: string): SourceFile {
  if (file.language === language) {
    return file
  }

  return {
    ...file,
    language,
  }
}
