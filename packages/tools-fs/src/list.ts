import { glob } from 'tinyglobby'

export const MAX_LISTED_FILES = 160

export const DEFAULT_IGNORE_PATTERNS: readonly string[] = [
  '**/.git/**',
  '**/build/**',
  '**/dist/**',
  '**/node_modules/**',
  '**/vendor/**',
]

export interface ListFilesOptions {
  dot?: boolean
  followSymbolicLinks?: boolean
  ignore?: readonly string[] | string
  maxFiles?: number
  patterns?: readonly string[] | string
}

export async function listFiles(root: string, options: ListFilesOptions = {}): Promise<string[]> {
  try {
    const files = await glob(options.patterns ?? '**/*', {
      absolute: true,
      cwd: root,
      dot: options.dot,
      followSymbolicLinks: options.followSymbolicLinks,
      ignore: toStringArray(options.ignore),
      onlyFiles: true,
    })

    return files.slice(0, options.maxFiles ?? MAX_LISTED_FILES)
  }
  catch {
    return []
  }
}

export function toStringArray(value: readonly string[] | string | undefined): string[] {
  if (Array.isArray(value)) {
    return [...value]
  }

  return typeof value === 'string' ? [value] : []
}
