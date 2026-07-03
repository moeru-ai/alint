import type { AlintConfig, AlintConfigItem } from '@alint-js/core'

import { readdir } from 'node:fs/promises'

import Gitignore from 'gitignore-fs'

import { hasDiscoveryFilePatterns, matchesDiscoveryFile, normalizeConfig } from '@alint-js/core'
import { minimatch } from 'minimatch'
import { relative, resolve } from 'pathe'

interface WalkFilesOptions {
  cwd: string
  gitignore?: Gitignore
  ignoredPatterns: readonly string[]
}

export async function resolveLintFiles(files: string[], config: AlintConfig, cwd: string): Promise<string[]> {
  const gitignore = shouldFilterGitignoredFiles(config) ? new Gitignore() : undefined
  const candidates = files.length > 0 ? files : await discoverLintFiles(config, cwd, gitignore)

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

async function discoverLintFiles(config: AlintConfig, cwd: string, gitignore?: Gitignore): Promise<string[]> {
  if (!hasDiscoveryFilePatterns(config)) {
    return []
  }

  const ignoredPatterns = collectGlobalIgnorePatterns(config)
  const files = await walkFiles(cwd, { cwd, gitignore, ignoredPatterns })
  const candidates = files
    .map(file => normalizeRelativePath(cwd, file))
    .filter(file => matchesDiscoveryFile(file, config, { cwd }))

  return [...new Set(candidates)].sort()
}

function isGlobalIgnoreItem(item: AlintConfigItem): item is AlintConfigItem & { ignores: readonly string[] } {
  const keys = Object.keys(item).filter(key => item[key as keyof AlintConfigItem] !== undefined)

  return item.ignores !== undefined && keys.every(key => key === 'ignores' || key === 'name')
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
