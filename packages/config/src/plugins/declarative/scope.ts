import { isAbsolute, relative, win32 } from 'node:path'

import { minimatch } from 'minimatch'
import { normalize } from 'pathe'

export interface CreateReportScopeOptions {
  cwd: string
  excludeFiles: readonly string[]
  includeFiles?: readonly string[]
  targetFilePath?: string
}

export interface ReportScope {
  canReport: (filePath: string | undefined) => boolean
}

export function createReportScope(options: CreateReportScopeOptions): ReportScope {
  const includeFiles = options.includeFiles
  const excludeFiles = options.excludeFiles
  const rawTargetFilePath = options.targetFilePath
  const hasTargetFilePath = rawTargetFilePath !== undefined
  const targetFilePath = rawTargetFilePath === undefined
    ? undefined
    : toScopedRelativePath(options.cwd, rawTargetFilePath)

  return {
    canReport(filePath) {
      if (filePath === undefined) {
        return !hasTargetFilePath && includeFiles === undefined
      }

      const relativePath = toScopedRelativePath(options.cwd, filePath)

      if (relativePath === undefined) {
        return false
      }

      const included = includeFiles === undefined
        ? targetFilePath !== undefined && relativePath === targetFilePath
        : includeFiles.some(pattern => minimatch(relativePath, pattern, { dot: true }))

      if (!included) {
        return false
      }

      return !excludeFiles.some(pattern => minimatch(relativePath, pattern, { dot: true }))
    },
  }
}

function isOutsideScopePath(path: string): boolean {
  return path === '..'
    || path.startsWith('../')
    || isAbsolute(path)
    || win32.isAbsolute(path)
    || /^[A-Za-z]:/u.test(path)
}

function normalizePath(path: string): string {
  return normalize(path).replace(/^\.\//u, '')
}

function toScopedRelativePath(cwd: string, filePath: string): string | undefined {
  const path = normalizePath(relative(cwd, filePath))

  if (isOutsideScopePath(path)) {
    return undefined
  }

  return path
}
