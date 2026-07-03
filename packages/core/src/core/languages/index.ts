import { javascriptLanguage } from './js'
import { createLanguageRegistry, registerLanguage } from './registry'
import { textLanguage } from './text'
import { typescriptLanguage } from './ts'

export { javascriptLanguage } from './js'
export { createLanguageRegistry, registerLanguage } from './registry'
export type { LanguageRegistry } from './registry'
export { resolveLanguage } from './resolve'
export type { ResolveLanguageOptions } from './resolve'
export { textLanguage } from './text'
export { typescriptLanguage } from './ts'

export function createBuiltInLanguageRegistry() {
  const registry = createLanguageRegistry()

  registerLanguage(registry, textLanguage)
  registerLanguage(registry, javascriptLanguage)
  registerLanguage(registry, typescriptLanguage)

  return registry
}
