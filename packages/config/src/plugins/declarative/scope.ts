import { relative } from 'node:path'

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
  const targetFilePath = options.targetFilePath === undefined
    ? undefined
    : normalizePath(relative(options.cwd, options.targetFilePath))

  return {
    canReport(filePath) {
      if (filePath === undefined) {
        return targetFilePath === undefined && includeFiles === undefined
      }

      const relativePath = normalizePath(relative(options.cwd, filePath))
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

function normalizePath(path: string): string {
  return normalize(path).replace(/^\.\//u, '')
}
