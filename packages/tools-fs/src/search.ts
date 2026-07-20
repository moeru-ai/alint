import type { ListFilesOptions } from './list'

import { Buffer } from 'node:buffer'
import { stat } from 'node:fs/promises'
import { relative, resolve } from 'node:path'

import { listFiles } from './list'
import { readCappedUtf8 } from './read-capped-utf8'
import { MAX_REPOSITORY_FILE_BYTES } from './repository'

const maxSearchResults = 24

export interface SearchOptions extends ListFilesOptions {
  directory?: string
}

interface LimitedResults {
  byteBudgetExhausted: boolean
  displayed: string[]
  total: number
}

export async function searchFileContents(
  cwd: string,
  query: string,
  files: readonly string[],
  maxTotalBytes = Number.POSITIVE_INFINITY,
): Promise<string> {
  const results = createLimitedResults()
  let remainingBytes = maxTotalBytes

  for (const file of files) {
    if (remainingBytes <= 0) {
      results.byteBudgetExhausted = true
      break
    }

    let fileSize: number

    try {
      fileSize = (await stat(file)).size
    }
    catch {
      continue
    }

    if (fileSize > MAX_REPOSITORY_FILE_BYTES) {
      continue
    }

    if (fileSize > remainingBytes) {
      results.byteBudgetExhausted = true
      break
    }

    let readResult: Awaited<ReturnType<typeof readCappedUtf8>>

    try {
      readResult = await readCappedUtf8(file, MAX_REPOSITORY_FILE_BYTES)
    }
    catch {
      continue
    }

    if (readResult.status !== 'content') {
      continue
    }

    remainingBytes -= Buffer.byteLength(readResult.text, 'utf8')

    if (readResult.text.includes(query)) {
      collectLineMatches(results, relative(cwd, file), query, readResult.text)
    }
  }

  return formatLimitedResults(results)
}

export function searchFilePaths(cwd: string, query: string, files: readonly string[]): string {
  const results = createLimitedResults()

  for (const file of files) {
    const relativePath = relative(cwd, file)

    if (relativePath.includes(query)) {
      collectResult(results, relativePath)
    }
  }

  return formatLimitedResults(results)
}

export async function searchFiles(cwd: string, query: string, options: SearchOptions = {}): Promise<string> {
  // Scope the walk to `directory` when given, but keep reported paths relative to
  // `cwd` so callers see stable project-root paths regardless of the search root.
  const root = resolve(cwd, options.directory ?? '.')
  const files = await listFiles(root, options)

  return searchFilePaths(cwd, query, files)
}

export async function searchInFiles(cwd: string, query: string, options: SearchOptions = {}): Promise<string> {
  const root = resolve(cwd, options.directory ?? '.')
  const files = await listFiles(root, options)
  return searchFileContents(cwd, query, files)
}

function collectLineMatches(results: LimitedResults, filePath: string, query: string, text: string): void {
  let lineNumber = 1
  let lineStart = 0

  while (lineStart <= text.length) {
    const newlineIndex = text.indexOf('\n', lineStart)
    const lineEnd = newlineIndex === -1 ? text.length : newlineIndex
    const line = text.slice(lineStart, lineEnd)

    if (line.includes(query)) {
      collectResult(results, `${filePath}:${lineNumber}: ${line.trim()}`)
    }

    if (newlineIndex === -1) {
      break
    }

    lineNumber += 1
    lineStart = newlineIndex + 1
  }
}

function collectResult(results: LimitedResults, result: string): void {
  results.total += 1

  if (results.displayed.length < maxSearchResults) {
    results.displayed.push(result)
  }
}

function createLimitedResults(): LimitedResults {
  return { byteBudgetExhausted: false, displayed: [], total: 0 }
}

function formatLimitedResults(results: LimitedResults): string {
  const output = [...results.displayed]

  if (results.total > results.displayed.length) {
    output.push(truncationMessage(results.displayed.length, results.total))
  }

  if (results.byteBudgetExhausted) {
    output.push('[truncated: repository content search stopped at the total byte budget]')
  }

  return output.join('\n')
}

function truncationMessage(displayed: number, total: number): string {
  return `[truncated: showing the first ${displayed} of ${total} matches]`
}
