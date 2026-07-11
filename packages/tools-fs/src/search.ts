import type { ListFilesOptions } from './list'

import { readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'

import { listFiles } from './list'

const maxSearchResults = 24
const maxSearchBytesPerFile = 200_000

export interface SearchOptions extends ListFilesOptions {
  directory?: string
}

export async function searchFiles(cwd: string, query: string, options: SearchOptions = {}): Promise<string> {
  // Scope the walk to `directory` when given, but keep reported paths relative to
  // `cwd` so callers see stable project-root paths regardless of the search root.
  const root = resolve(cwd, options.directory ?? '.')
  const files = await listFiles(root, options)

  return files
    .filter(file => relative(cwd, file).includes(query))
    .slice(0, maxSearchResults)
    .map(file => relative(cwd, file))
    .join('\n')
}

export async function searchInFiles(cwd: string, query: string, options: SearchOptions = {}): Promise<string> {
  const root = resolve(cwd, options.directory ?? '.')
  const files = await listFiles(root, options)
  const snippets: string[] = []

  for (const file of files) {
    if (snippets.length >= maxSearchResults) {
      break
    }

    let text: string

    try {
      text = await readFile(file, 'utf8')
    }
    catch {
      continue
    }

    if (text.length > maxSearchBytesPerFile || !text.includes(query)) {
      continue
    }

    for (const [index, line] of text.split('\n').entries()) {
      if (!line.includes(query)) {
        continue
      }

      snippets.push(`${relative(cwd, file)}:${index + 1}: ${line.trim()}`)

      if (snippets.length >= maxSearchResults) {
        break
      }
    }
  }

  return snippets.join('\n')
}
