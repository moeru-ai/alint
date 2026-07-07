import type { Stats } from 'node:fs'

import type { AlintConfig, AlintConfigItem } from '@alint-js/core'

import { readdir, stat } from 'node:fs/promises'

import Gitignore from 'gitignore-fs'

import { hasDiscoveryFilePatterns, matchesDiscoveryFile, normalizeConfig, resolveConfigForFile } from '@alint-js/core'
import { minimatch, Minimatch } from 'minimatch'
import { isAbsolute, relative, resolve } from 'pathe'

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

interface SearchGlobOptions {
  config: AlintConfig
  cwd: string
  gitignore?: Gitignore
  hasFilePatterns: boolean
  ignoredPatterns: readonly string[]
  pattern: string
}

interface WalkFilesOptions {
  cwd: string
  gitignore?: Gitignore
  ignoredPatterns: readonly string[]
}

const minimatchOptions = { dot: true }

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

function getGlobParent(input: string): string {
  const normalized = input.replaceAll('\\', '/')
  const segments = normalized.split('/')
  const parentSegments: string[] = []

  for (const segment of segments) {
    if (isGlobPattern(segment)) {
      break
    }

    parentSegments.push(segment)
  }

  const parent = parentSegments.join('/')
  return parent === '' ? '.' : parent
}

function isGlobalIgnoreItem(item: AlintConfigItem): item is AlintConfigItem & { ignores: readonly string[] } {
  const keys = Object.keys(item).filter(key => item[key as keyof AlintConfigItem] !== undefined)

  return item.ignores !== undefined && keys.every(key => key === 'ignores' || key === 'name')
}

function isGlobPattern(input: string): boolean {
  return new Minimatch(input, minimatchOptions).hasMagic()
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function matchesGlob(filePath: string, pattern: string): boolean {
  return minimatch(filePath, pattern.replaceAll('\\', '/'), minimatchOptions)
}

function matchesIgnoredDirectory(relativePath: string, patterns: readonly string[]): boolean {
  return patterns.some(pattern =>
    minimatch(relativePath, pattern, minimatchOptions)
    || minimatch(`${relativePath}/`, pattern, minimatchOptions)
    || minimatch(`${relativePath}/__alint__`, pattern, minimatchOptions),
  )
}

function normalizeGlobPattern(cwd: string, pattern: string): string {
  return isAbsolute(pattern)
    ? normalizeRelativePath(cwd, pattern)
    : pattern.replaceAll('\\', '/')
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

      if (await shouldPruneDirectory(path, {
        cwd: options.cwd,
        gitignore: options.gitignore,
        ignoredPatterns,
      })) {
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

    if (options.globInputPaths && isGlobPattern(input)) {
      const matches = await searchGlob({
        config: options.config,
        cwd: options.cwd,
        gitignore: options.gitignore,
        hasFilePatterns,
        ignoredPatterns,
        pattern: input,
      })

      if (matches.length === 0 && options.errorOnUnmatchedPattern) {
        throw new NoFilesFoundError(input, { globInputPaths: options.globInputPaths })
      }

      candidates.push(...matches)
      continue
    }

    if (options.errorOnUnmatchedPattern) {
      throw new NoFilesFoundError(input, { globInputPaths: options.globInputPaths })
    }
  }

  return [...new Set(candidates)]
}

async function searchGlob(options: SearchGlobOptions): Promise<string[]> {
  const root = resolve(options.cwd, getGlobParent(options.pattern))
  const rootStats = await statPath(root)
  const pattern = normalizeGlobPattern(options.cwd, options.pattern)

  if (!rootStats?.isDirectory()) {
    return []
  }

  const files = (await walkFiles(root, {
    cwd: options.cwd,
    gitignore: options.gitignore,
    ignoredPatterns: options.ignoredPatterns,
  })).sort()
  const candidates: string[] = []

  for (const file of files) {
    const relativePath = normalizeRelativePath(options.cwd, file)

    if (matchesGlob(relativePath, pattern) && shouldIncludeGlobCandidate(relativePath, options.config, {
      cwd: options.cwd,
      hasFilePatterns: options.hasFilePatterns,
    })) {
      candidates.push(relativePath)
    }
  }

  return candidates
}

function shouldFilterGitignoredFiles(config: AlintConfig): boolean {
  return normalizeConfig(config).some(item => item.ignore?.gitignore === true)
}

function shouldIncludeGlobCandidate(
  filePath: string,
  config: AlintConfig,
  options: { cwd: string, hasFilePatterns: boolean },
): boolean {
  if (options.hasFilePatterns) {
    return matchesDiscoveryFile(filePath, config, { cwd: options.cwd })
  }

  return !resolveConfigForFile(filePath, config, { cwd: options.cwd }).ignored
}

async function shouldPruneDirectory(path: string, options: WalkFilesOptions): Promise<boolean> {
  const relativePath = normalizeRelativePath(options.cwd, path)

  if (matchesIgnoredDirectory(relativePath, options.ignoredPatterns)) {
    return true
  }

  return await options.gitignore?.ignores(`${path}/`) === true
}

async function statPath(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path)
  }
  catch (error) {
    if (isNodeError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
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
