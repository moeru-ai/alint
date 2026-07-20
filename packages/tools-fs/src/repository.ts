import { realpath } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep, win32 } from 'node:path'

import { escapePath, glob } from 'tinyglobby'

import { readCappedUtf8 } from './read-capped-utf8'

export const MAX_REPOSITORY_FILE_BYTES = 200_000
export const MAX_REPOSITORY_SEARCH_BYTES = 20_000_000

const CREDENTIAL_FILE_NAMES: readonly string[] = [
  '.git-credentials',
  '.netrc',
  '.npmrc',
  '.pypirc',
]

const CREDENTIAL_CONTAINER_PATHS: readonly string[] = [
  '.aws/config',
  '.aws/credentials',
  '.config/gcloud/application_default_credentials.json',
  '.config/gh/hosts.yml',
  '.docker/config.json',
]

export const REPOSITORY_SECRET_IGNORE_PATTERNS: readonly string[] = [
  '**/.env',
  '**/.env.local',
  '**/.envrc',
  ...CREDENTIAL_FILE_NAMES.map(name => `**/${name}`),
  ...CREDENTIAL_CONTAINER_PATHS.map(path => `**/${path}`),
  '**/credentials',
  '**/credentials.config',
  '**/credentials.ini',
  '**/credentials.json',
  '**/credentials.toml',
  '**/credentials.yaml',
  '**/credentials.yml',
  '**/*.key',
  '**/*.pem',
  '**/id_dsa',
  '**/id_ecdsa',
  '**/id_ed25519',
  '**/id_rsa',
]

export interface RepositoryAccess {
  canonicalRoot: () => Promise<string>
  filterFiles: (files: readonly string[]) => Promise<string[]>
  readFile: (inputPath: string | undefined) => Promise<string>
  resolveDirectory: (inputPath: string | undefined) => Promise<string>
  validatePatterns: (patterns: readonly string[] | string | undefined) => void
}

export class RepositoryToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RepositoryToolError'
  }
}

export function createRepositoryAccess(cwd: string, ignore: readonly string[]): RepositoryAccess {
  // NOTICE: Confinement assumes a static checkout for one tool execution. These
  // checks defend stable lexical and symlink escapes; concurrent mutation by an
  // actor who can write the checkout is outside this filesystem tool's threat model.
  let canonicalRootPromise: Promise<string> | undefined
  const canonicalRoot = () => {
    canonicalRootPromise ??= realpath(cwd).catch(() => {
      throw new RepositoryToolError('Repository-confined filesystem tools could not resolve the repository root.')
    })

    return canonicalRootPromise
  }

  const resolvePath = async (inputPath: string, kind: 'directory' | 'file'): Promise<string> => {
    assertRelativePath(inputPath, kind)

    const root = await canonicalRoot()
    let target: string

    try {
      // Validate the canonical target, not just the lexical path, so a repository symlink
      // cannot redirect a tool into a sibling checkout or an operating-system directory.
      target = await realpath(resolve(root, inputPath))
    }
    catch {
      throw new RepositoryToolError(`Repository-confined ${kind} access could not resolve the requested path.`)
    }

    if (!isWithin(root, target)) {
      throw new RepositoryToolError(`Repository-confined ${kind} access denied: the resolved path is outside the repository.`)
    }

    return target
  }

  return {
    canonicalRoot,
    filterFiles: async (files) => {
      const root = await canonicalRoot()
      const safeFiles: string[] = []
      const seen = new Set<string>()

      for (const file of files) {
        let target: string

        try {
          target = await realpath(file)
        }
        catch {
          continue
        }

        if (!isWithin(root, target) || seen.has(target)) {
          continue
        }

        const relativePath = toPosixPath(relative(root, target))

        if (isLikelySecret(relativePath) || await isIgnored(root, relativePath, ignore)) {
          continue
        }

        seen.add(target)
        safeFiles.push(target)
      }

      return safeFiles
    },
    readFile: async (inputPath) => {
      if (!inputPath) {
        throw new RepositoryToolError('Repository-confined read_file requires a relative file path.')
      }

      const target = await resolvePath(inputPath, 'file')
      const root = await canonicalRoot()
      const relativePath = toPosixPath(relative(root, target))

      if (isLikelySecret(inputPath) || isLikelySecret(relativePath)) {
        throw new RepositoryToolError('Repository-confined read_file denied: the requested path is a likely secret file.')
      }

      if (await isIgnored(root, relativePath, ignore)) {
        throw new RepositoryToolError('Repository-confined read_file denied: the requested path is ignored by repository policy.')
      }

      const result = await readCappedUtf8(target, MAX_REPOSITORY_FILE_BYTES)

      if (result.status === 'not-file') {
        throw new RepositoryToolError('Repository-confined read_file denied: the requested path is not a regular file.')
      }

      if (result.status === 'too-large') {
        throw new RepositoryToolError(`Repository-confined read_file denied: the file exceeds the maximum readable size of ${MAX_REPOSITORY_FILE_BYTES} bytes.`)
      }

      return result.text
    },
    resolveDirectory: inputPath => resolvePath(inputPath ?? '.', 'directory'),
    validatePatterns: (patterns) => {
      for (const pattern of toArray(patterns)) {
        assertRelativePath(pattern.startsWith('!') ? pattern.slice(1) : pattern, 'search pattern')
      }
    },
  }
}

function assertRelativePath(inputPath: string, kind: string): void {
  if (isAbsolute(inputPath) || win32.isAbsolute(inputPath)) {
    throw new RepositoryToolError(`Repository-confined ${kind} access denied: absolute paths are not allowed.`)
  }

  if (inputPath.split(/[\\/]+/).includes('..')) {
    throw new RepositoryToolError(`Repository-confined ${kind} access denied: parent traversal is not allowed.`)
  }
}

function isCredentialContainerPath(inputPath: string): boolean {
  return CREDENTIAL_CONTAINER_PATHS.some(path => inputPath === path
    || inputPath.endsWith(`/${path}`)
    || inputPath.startsWith(`${path}.`)
    || inputPath.includes(`/${path}.`))
}

function isCredentialSourceFile(name: string): boolean {
  return /^credentials(?:\.d)?\.(?:c|cc|cpp|cs|cts|go|h|hpp|java|js|jsx|kt|kts|mjs|mts|php|py|rb|rs|swift|ts|tsx)$/.test(name)
}

async function isIgnored(root: string, relativePath: string, ignore: readonly string[]): Promise<boolean> {
  if (ignore.length === 0) {
    return false
  }

  const matches = await glob(escapePath(relativePath), {
    cwd: root,
    dot: true,
    followSymbolicLinks: false,
    ignore,
    onlyFiles: true,
  })

  return matches.length === 0
}

function isLikelySecret(inputPath: string): boolean {
  const normalizedPath = toPosixPath(inputPath).toLowerCase()
  const name = basename(normalizedPath)

  if (isCredentialContainerPath(normalizedPath)) {
    return true
  }

  if (isSafeTemplate(name) || isCredentialSourceFile(name)) {
    return false
  }

  return CREDENTIAL_FILE_NAMES.some(credentialName => name === credentialName || name.startsWith(`${credentialName}.`))
    || name === '.env'
    || name === '.envrc'
    || name.startsWith('.env.')
    || name === 'credentials'
    || name.startsWith('credentials.')
    || name.endsWith('.key')
    || name.endsWith('.pem')
    || /^(?:id_dsa|id_ecdsa|id_ed25519|id_rsa)$/.test(name)
}

function isSafeTemplate(name: string): boolean {
  return /(?:^|\.)(?:example|sample|template)$/.test(name)
}

function isWithin(root: string, target: string): boolean {
  const relativePath = relative(root, target)

  return relativePath === ''
    || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
}

function toArray(value: readonly string[] | string | undefined): readonly string[] {
  return Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? [value]
      : []
}

function toPosixPath(filePath: string): string {
  return filePath.split(sep).join('/')
}
