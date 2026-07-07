import type { Stats } from 'node:fs'

import type { AlintConfig, AlintConfigItem } from '@alint-js/core'

import { readdir, stat } from 'node:fs/promises'

import Gitignore from 'gitignore-fs'

import { hasDiscoveryFilePatterns, matchesDiscoveryFile, normalizeConfig } from '@alint-js/core'
import { minimatch } from 'minimatch'
import { relative, resolve } from 'pathe'

export interface FindFilesOptions {
  config: AlintConfig
  cwd: string
  errorOnUnmatchedPattern?: boolean
  globInputPaths?: boolean
  inputs: string[]
}

interface ResolveInputFilesOptions {
  config: AlintConfig
  cwd: string
  errorOnUnmatchedPattern: boolean
  gitignore?: Gitignore
  globInputPaths: boolean
  inputs: string[]
}

interface WalkFilesOptions {
  cwd: string
  gitignore?: Gitignore
  ignoredPatterns: readonly string[]
}

export class NoFilesFoundError extends Error {
  readonly globInputPaths: boolean
  readonly pattern: string

  constructor(pattern: string, options: { globInputPaths: boolean }) {
    super(`No files matching "${pattern}" were found${options.globInputPaths ? '' : ' (glob input is disabled)'}.`)
    this.name = 'NoFilesFoundError'
    this.globInputPaths = options.globInputPaths
    this.pattern = pattern
  }
}

export async function findFiles(options: FindFilesOptions): Promise<string[]> {
  const {
    config,
    cwd,
    errorOnUnmatchedPattern = true,
    globInputPaths = true,
    inputs,
  } = options
  const gitignore = shouldFilterGitignoredFiles(config) ? new Gitignore() : undefined
  const candidates = await resolveInputFiles({
    config,
    cwd,
    errorOnUnmatchedPattern,
    gitignore,
    globInputPaths,
    inputs: inputs.length > 0 ? inputs : ['.'],
  })

  if (!gitignore || candidates.length === 0) {
    return candidates
  }

  const lintFiles: string[] = []

  for (const file of candidates) {
    if (await gitignore.ignores(resolve(cwd, file))) {
      continue
    }

    lintFiles.push(file)
  }

  return lintFiles
}

function collectGlobalIgnorePatterns(config: AlintConfig): string[] {
  return normalizeConfig(config).flatMap(item =>
    isGlobalIgnoreItem(item) ? [...item.ignores] : [],
  )
}

function isGlobalIgnoreItem(item: AlintConfigItem): item is AlintConfigItem & { ignores: readonly string[] } {
  const keys = Object.keys(item).filter(key => item[key as keyof AlintConfigItem] !== undefined)

  return item.ignores !== undefined && keys.every(key => key === 'ignores' || key === 'name')
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function matchesIgnoredDirectory(relativePath: string, patterns: readonly string[]): boolean {
  return patterns.some(pattern =>
    minimatch(relativePath, pattern, { dot: true })
    || minimatch(`${relativePath}/`, pattern, { dot: true })
    || minimatch(`${relativePath}/__alint__`, pattern, { dot: true }),
  )
}

function normalizeRelativePath(cwd: string, filePath: string): string {
  return relative(cwd, filePath).replaceAll('\\', '/')
}

async function resolveInputFiles(options: ResolveInputFilesOptions): Promise<string[]> {
  const hasFilePatterns = hasDiscoveryFilePatterns(options.config)
  const ignoredPatterns = collectGlobalIgnorePatterns(options.config)
  const candidates: string[] = []

  for (const input of options.inputs) {
    const path = resolve(options.cwd, input)
    const stats = await statPath(path)

    if (stats?.isFile()) {
      candidates.push(input)
      continue
    }

    if (stats?.isDirectory()) {
      if (!hasFilePatterns) {
        continue
      }

      const directoryFiles = (await walkFiles(path, {
        cwd: options.cwd,
        gitignore: options.gitignore,
        ignoredPatterns,
      })).sort()

      for (const directoryFile of directoryFiles) {
        const relativePath = normalizeRelativePath(options.cwd, directoryFile)

        if (hasFilePatterns && matchesDiscoveryFile(relativePath, options.config, { cwd: options.cwd })) {
          candidates.push(relativePath)
        }
      }

      continue
    }

    if (options.errorOnUnmatchedPattern) {
      throw new NoFilesFoundError(input, { globInputPaths: options.globInputPaths })
    }
  }

  return [...new Set(candidates)]
}

function shouldFilterGitignoredFiles(config: AlintConfig): boolean {
  return normalizeConfig(config).some(item => item.ignore?.gitignore === true)
}

async function shouldPruneDirectory(path: string, options: WalkFilesOptions): Promise<boolean> {
  const relativePath = normalizeRelativePath(options.cwd, path)

  if (matchesIgnoredDirectory(relativePath, options.ignoredPatterns)) {
    return true
  }

  return await options.gitignore?.ignores(path) === true
}

async function statPath(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path)
  }
  catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return undefined
    }

    throw error
  }
}

async function walkFiles(root: string, options: WalkFilesOptions): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const path = resolve(root, entry.name)
    if (entry.isDirectory()) {
      if (!await shouldPruneDirectory(path, options)) {
        files.push(...await walkFiles(path, options))
      }
      continue
    }

    if (entry.isFile()) {
      files.push(path)
    }
  }

  return files
}
