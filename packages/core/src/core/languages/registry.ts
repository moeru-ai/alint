import type { LanguageDefinition } from '../../dsl/types'

export interface LanguageRegistry {
  byExtension: Map<string, string>
  languages: Map<string, LanguageDefinition>
}

export function createLanguageRegistry(): LanguageRegistry {
  return {
    byExtension: new Map(),
    languages: new Map(),
  }
}

export function registerLanguage(registry: LanguageRegistry, language: LanguageDefinition): void {
  const existing = registry.languages.get(language.name)
  if (existing && existing !== language) {
    throw new Error(`Duplicate language "${language.name}".`)
  }

  for (const extension of language.extensions ?? []) {
    const existingOwner = registry.byExtension.get(extension)
    if (existingOwner && existingOwner !== language.name) {
      throw new Error(`Duplicate language extension "${extension}".`)
    }
  }

  registry.languages.set(language.name, language)

  for (const extension of language.extensions ?? []) {
    registry.byExtension.set(extension, language.name)
  }
}
