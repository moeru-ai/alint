import type { AgentTool } from '@alint-js/core/agent'

import type { SearchOptions } from './search'

import { relative, resolve } from 'node:path'

import { DEFAULT_IGNORE_PATTERNS, listFiles, MAX_LISTED_FILES, toStringArray } from './list'
import { readFile } from './read'
import {
  createRepositoryAccess,
  MAX_REPOSITORY_SEARCH_BYTES,
  REPOSITORY_SECRET_IGNORE_PATTERNS,
  RepositoryToolError,
} from './repository'
import { searchFileContents, searchFilePaths, searchFiles, searchInFiles } from './search'

export type { ListFilesOptions } from './list'
export type { SearchOptions } from './search'
export { DEFAULT_IGNORE_PATTERNS, listFiles, readFile, RepositoryToolError, searchFiles, searchInFiles, toStringArray }

export interface CreateToolsOptions {
  confined?: boolean
  ignore?: readonly string[] | string
}

export function createTools(cwd: string, options: CreateToolsOptions = {}): AgentTool[] {
  const configuredIgnore = toStringArray(options.ignore)
  const baseIgnore = options.confined
    ? [...DEFAULT_IGNORE_PATTERNS, ...configuredIgnore, ...REPOSITORY_SECRET_IGNORE_PATTERNS]
    : options.ignore === undefined
      ? DEFAULT_IGNORE_PATTERNS
      : configuredIgnore
  const repository = options.confined ? createRepositoryAccess(cwd, baseIgnore) : undefined

  return [
    {
      description: repository
        ? 'Read a non-secret UTF-8 text file inside the repository. Only relative paths are accepted.'
        : 'Read a UTF-8 text file. The path may be relative to the project root or absolute.',
      execute: input => repository
        ? repository.readFile(getStringProperty(input, 'path'))
        : readFile(cwd, getStringProperty(input, 'path')),
      name: 'read_file',
      parameters: {
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
        },
        required: ['path'],
        type: 'object',
      },
    },
    {
      description: 'List files under a directory with optional glob patterns and ignore patterns.',
      execute: async (input) => {
        const listOptions = getListOptions(input, baseIgnore, repository !== undefined)
        repository?.validatePatterns(listOptions.directory)
        repository?.validatePatterns(getStringOrStringArrayProperty(input, 'patterns'))
        repository?.validatePatterns(getStringOrStringArrayProperty(input, 'ignore'))
        const dir = repository
          ? await repository.resolveDirectory(listOptions.directory)
          : resolve(cwd, listOptions.directory ?? '.')
        const discoveredFiles = await listFiles(dir, { ...listOptions, maxFiles: Number.POSITIVE_INFINITY })
        const files = repository ? await repository.filterFiles(discoveredFiles) : discoveredFiles
        const reportRoot = repository ? await repository.canonicalRoot() : cwd

        return formatFileListing(reportRoot, files)
      },
      name: 'list_files',
      parameters: fileSearchParameters(false),
    },
    {
      description: 'Search listed file paths by substring. Use search_in_files to search file contents.',
      execute: async (input) => {
        const query = getRequiredStringProperty(input, 'query')
        const listOptions = getListOptions(input, baseIgnore, repository !== undefined)

        if (!repository) {
          return searchFiles(cwd, query, { ...listOptions, maxFiles: Number.POSITIVE_INFINITY })
        }

        const { files, reportRoot } = await confinedFiles(repository, input, listOptions)

        return searchFilePaths(reportRoot, query, files)
      },
      name: 'search_files',
      parameters: fileSearchParameters(true),
    },
    {
      description: 'Search file contents by literal substring and return path:line snippets.',
      execute: async (input) => {
        const query = getRequiredStringProperty(input, 'query')
        const listOptions = getListOptions(input, baseIgnore, repository !== undefined)

        if (!repository) {
          return searchInFiles(cwd, query, { ...listOptions, maxFiles: Number.POSITIVE_INFINITY })
        }

        const { files, reportRoot } = await confinedFiles(repository, input, listOptions)

        return searchFileContents(reportRoot, query, files, MAX_REPOSITORY_SEARCH_BYTES)
      },
      name: 'search_in_files',
      parameters: fileSearchParameters(true),
    },
  ]
}

async function confinedFiles(
  repository: ReturnType<typeof createRepositoryAccess>,
  input: unknown,
  options: SearchOptions,
): Promise<{ files: string[], reportRoot: string }> {
  repository.validatePatterns(options.directory)
  repository.validatePatterns(getStringOrStringArrayProperty(input, 'patterns'))
  repository.validatePatterns(getStringOrStringArrayProperty(input, 'ignore'))

  const directory = await repository.resolveDirectory(options.directory)
  const discoveredFiles = await listFiles(directory, { ...options, maxFiles: Number.POSITIVE_INFINITY })

  return {
    files: await repository.filterFiles(discoveredFiles),
    reportRoot: await repository.canonicalRoot(),
  }
}

function fileSearchParameters(requiresQuery: boolean): Record<string, unknown> {
  const properties = {
    directory: nullableStringSchema(),
    ignore: stringOrStringArraySchema(),
    patterns: stringOrStringArraySchema(),
    ...(requiresQuery ? { query: { minLength: 1, pattern: '\\S', type: 'string' } } : {}),
  }

  return {
    additionalProperties: false,
    properties,
    required: Object.keys(properties),
    type: 'object',
  }
}

function formatFileListing(cwd: string, files: readonly string[]): string {
  const displayed = files.slice(0, MAX_LISTED_FILES).map(path => relative(cwd, path))

  if (files.length > MAX_LISTED_FILES) {
    displayed.push(`[truncated: showing the first ${MAX_LISTED_FILES} of ${files.length} files]`)
  }

  return displayed.join('\n')
}

function getListOptions(input: unknown, baseIgnore: readonly string[], confined: boolean): SearchOptions {
  return {
    directory: getStringProperty(input, 'directory'),
    dot: confined ? true : undefined,
    followSymbolicLinks: confined ? false : undefined,
    ignore: [...baseIgnore, ...toStringArray(getStringOrStringArrayProperty(input, 'ignore'))],
    patterns: getStringOrStringArrayProperty(input, 'patterns'),
  }
}

function getRequiredStringProperty(input: unknown, key: string): string {
  const value = getStringProperty(input, key)

  if (value === undefined) {
    throw new TypeError(`Expected tool input property "${key}" to be a string`)
  }

  if (value.trim().length === 0) {
    throw new TypeError(`Expected tool input property "${key}" to be a non-blank string`)
  }

  return value
}

function getStringOrStringArrayProperty(input: unknown, key: string): readonly string[] | string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return undefined
  }

  const value = (input as Record<string, unknown>)[key]

  if (typeof value === 'string') {
    return value
  }

  return Array.isArray(value) && value.every(item => typeof item === 'string')
    ? value
    : undefined
}

function getStringProperty(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return undefined
  }

  const value = (input as Record<string, unknown>)[key]

  return typeof value === 'string' ? value : undefined
}

function nullableStringSchema(): Record<string, unknown> {
  return {
    anyOf: [
      { type: 'string' },
      { type: 'null' },
    ],
  }
}

function stringOrStringArraySchema(): Record<string, unknown> {
  return {
    anyOf: [
      { type: 'string' },
      {
        items: { type: 'string' },
        type: 'array',
      },
      { type: 'null' },
    ],
  }
}
