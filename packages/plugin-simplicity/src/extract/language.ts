import type { ExtractLanguage } from './types'

import { extname } from 'node:path'

const LANGUAGE_BY_EXTENSION: Record<string, ExtractLanguage> = {
  '.cjs': 'javascript',
  '.cts': 'typescript',
  '.go': 'go',
  '.js': 'javascript',
  '.jsx': 'tsx',
  '.mjs': 'javascript',
  '.mts': 'typescript',
  '.py': 'python',
  '.rs': 'rust',
  '.ts': 'typescript',
  '.tsx': 'tsx',
}

export function resolveExtractLanguage(filePath: string): ExtractLanguage | undefined {
  return LANGUAGE_BY_EXTENSION[extname(filePath)]
}
