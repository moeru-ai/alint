import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import Parser from 'web-tree-sitter'

// Pinned to `web-tree-sitter` 0.24.x, which has to be upgraded together with `tree-sitter-wasms`.
// 0.25 rewrote the WASM loader, and both 0.25 and 0.26 reject the prebuilt 0.1.x grammars, because
// those still carry the legacy `dylink` section. Unpin only once `tree-sitter-wasms` ships grammars
// the newer loader accepts.

// Grammars are read from `node_modules` at run time rather than bundled, so this package has to be
// installed by a package manager. The plugin store extracts a single tarball and installs no
// dependencies, so it cannot distribute this package.
const nodeRequire = createRequire(import.meta.url)
const grammarDir = join(dirname(nodeRequire.resolve('tree-sitter-wasms/package.json')), 'out')

/**
 * Which languages this package provides, and the grammar each is parsed with. Adding a language
 * starts here: `LanguageId` is derived from these keys, and `QUERIES` must then cover it too.
 *
 * Ids are spelled as editors spell them, per the convention on `LanguageDefinition.name`.
 * TypeScript and JavaScript are deliberately missing — core's oxc producer already owns those
 * extensions, and `registerLanguage` throws when two plugins claim the same one.
 */
const GRAMMAR = {
  go: 'tree-sitter-go.wasm',
  python: 'tree-sitter-python.wasm',
  rust: 'tree-sitter-rust.wasm',
} as const

export type LanguageId = keyof typeof GRAMMAR

// Module scope on purpose: initializing the runtime costs around 18ms and each grammar another
// 6-8ms, paid once here instead of once per file.
let ready: Promise<void> | undefined
const grammars = new Map<LanguageId, Parser.Language>()

export async function grammarFor(language: LanguageId): Promise<Parser.Language> {
  ready ??= Parser.init()
  await ready

  let grammar = grammars.get(language)
  if (grammar === undefined) {
    grammar = await Parser.Language.load(join(grammarDir, GRAMMAR[language]))
    grammars.set(language, grammar)
  }

  return grammar
}

export function isLanguageId(value: string): value is LanguageId {
  return Object.hasOwn(GRAMMAR, value)
}
