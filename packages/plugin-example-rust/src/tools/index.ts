import type { AgentTool } from '@alint-js/core/agent'

import type { ListFilesOptions } from './list'

import { relative, resolve } from 'node:path'

import { listFiles } from './list'
import { readFile } from './read'
import { searchFiles, searchInFiles } from './search'

export { listFiles, readFile, searchFiles, searchInFiles }

export function createTools(cwd: string): AgentTool[] {
  return [
    {
      description: 'Read a UTF-8 text file. The path may be relative to the project root or absolute.',
      execute: input => readFile(cwd, getStringProperty(input, 'path')),
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
        const dir = resolve(cwd, getStringProperty(input, 'directory') ?? '.')
        const files = await listFiles(dir, getListOptions(input))

        return files.map(path => relative(cwd, path)).join('\n')
      },
      name: 'list_files',
      parameters: fileSearchParameters(false),
    },
    {
      description: 'Search listed file paths by substring. Use search_in_files to search file contents.',
      execute: input => searchFiles(cwd, getRequiredStringProperty(input, 'query'), getListOptions(input)),
      name: 'search_files',
      parameters: fileSearchParameters(true),
    },
    {
      description: 'Search file contents by literal substring and return path:line snippets.',
      execute: input => searchInFiles(cwd, getRequiredStringProperty(input, 'query'), getListOptions(input)),
      name: 'search_in_files',
      parameters: fileSearchParameters(true),
    },
  ]
}

function fileSearchParameters(requiresQuery: boolean): Record<string, unknown> {
  return {
    additionalProperties: false,
    properties: {
      directory: { type: 'string' },
      ignore: stringOrStringArraySchema(),
      patterns: stringOrStringArraySchema(),
      ...(requiresQuery ? { query: { type: 'string' } } : {}),
    },
    required: requiresQuery ? ['query'] : [],
    type: 'object',
  }
}

function getListOptions(input: unknown): ListFilesOptions {
  return {
    ignore: getStringOrStringArrayProperty(input, 'ignore'),
    patterns: getStringOrStringArrayProperty(input, 'patterns'),
  }
}

function getRequiredStringProperty(input: unknown, key: string): string {
  const value = getStringProperty(input, key)

  if (value === undefined) {
    throw new TypeError(`Expected tool input property "${key}" to be a string`)
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

function stringOrStringArraySchema(): Record<string, unknown> {
  return {
    anyOf: [
      { type: 'string' },
      {
        items: { type: 'string' },
        type: 'array',
      },
    ],
  }
}
