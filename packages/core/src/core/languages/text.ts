import type { LanguageDefinition } from '../../dsl/types'

export const textLanguage: LanguageDefinition = {
  extensions: [],
  extract: file => [{
    file,
    identity: 'file',
    kind: 'file',
    language: 'text/plain',
    origin: { physicalPath: file.path },
    text: file.text,
  }],
  name: 'text/plain',
}
