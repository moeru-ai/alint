import type { SourceFile } from '../source/types'
import type { LanguageRegistry } from './registry'

import { extname } from 'node:path'

export interface ResolveLanguageOptions {
  language?: string
  processedLanguage?: string
}

export function resolveLanguage(
  file: SourceFile,
  registry: LanguageRegistry,
  options: ResolveLanguageOptions,
) {
  const languageName = options.language
    ?? options.processedLanguage
    ?? registry.byExtension.get(extname(file.path))
    ?? 'text/plain'
  const language = registry.languages.get(languageName)

  if (!language) {
    throw new Error(`Unknown language "${languageName}".`)
  }

  return language
}
