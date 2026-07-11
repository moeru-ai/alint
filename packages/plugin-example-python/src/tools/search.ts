import type { ListFilesOptions } from './list'

import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'

import { listFiles } from './list'

const maxSearchResults = 24
const maxSearchBytesPerFile = 200_000

export async function searchFiles(cwd: string, query: string, options: ListFilesOptions = {}): Promise<string> {
  const files = await listFiles(cwd, options)

  return files
    .filter(file => relative(cwd, file).includes(query))
    .slice(0, maxSearchResults)
    .map(file => relative(cwd, file))
    .join('\n')
}

export async function searchInFiles(cwd: string, query: string, options: ListFilesOptions = {}): Promise<string> {
  const files = await listFiles(cwd, options)
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
