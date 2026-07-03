import type { LanguageDefinition } from '../../../dsl/types'
import type { SourceFile } from '../../source/types'

import { extractJsSourceTargets } from './extract'

export const javascriptLanguage: LanguageDefinition = {
  extensions: ['.cjs', '.js', '.jsx', '.mjs'],
  extract: file => extractJsSourceTargets(withLanguage(file, 'javascript')),
  name: 'javascript',
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
