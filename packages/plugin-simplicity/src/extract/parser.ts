import type { ExtractLanguage } from './types'

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import Parser from 'web-tree-sitter'

// `web-tree-sitter` is pinned to 0.24.x with `tree-sitter-wasms` 0.1.x; 0.25 rewrote the WASM
// loader and fails on these prebuilt grammars. Grammars are resolved at runtime, not bundled.
const nodeRequire = createRequire(import.meta.url)
const grammarDir = join(dirname(nodeRequire.resolve('tree-sitter-wasms/package.json')), 'out')

const GRAMMAR: Record<ExtractLanguage, string> = {
  go: 'tree-sitter-go.wasm',
  javascript: 'tree-sitter-typescript.wasm', // TS is a superset of JS.
  python: 'tree-sitter-python.wasm',
  rust: 'tree-sitter-rust.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  typescript: 'tree-sitter-typescript.wasm',
}

let ready: Promise<void> | undefined
const grammars = new Map<ExtractLanguage, Parser.Language>()

/** Grammars are loaded once per process; each WASM load costs tens of milliseconds. */
export async function grammarFor(language: ExtractLanguage): Promise<Parser.Language> {
  ready ??= Parser.init()
  await ready

  let grammar = grammars.get(language)
  if (grammar === undefined) {
    grammar = await Parser.Language.load(join(grammarDir, GRAMMAR[language]))
    grammars.set(language, grammar)
  }

  return grammar
}
