import type { LanguageDefinition } from '../../dsl/types'
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
): LanguageDefinition {
  return resolveLanguageForPath(file.path, registry, options)
}

export function resolveLanguageForPath(
  filePath: string,
  registry: LanguageRegistry,
  options: ResolveLanguageOptions,
): LanguageDefinition {
  const languageName = options.language
    ?? options.processedLanguage
    ?? registry.byExtension.get(extname(filePath))
    ?? 'text/plain'
  const language = registry.languages.get(languageName)

  if (!language) {
    throw new Error(`Unknown language "${languageName}".`)
  }

  return language
}
