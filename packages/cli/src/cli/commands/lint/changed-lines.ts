import type { RunResult } from '@alint-js/core'

import type { ChangedLineRange } from '../../git'

import { isAbsolute, relative } from 'pathe'

export interface FilterResultToChangedLinesOptions {
  changedLines: ReadonlyMap<string, readonly ChangedLineRange[]>
  cwd: string
}

/** Keeps file-wide diagnostics and diagnostics whose locations intersect the current Git change. */
export function filterResultToChangedLines(
  result: RunResult,
  options: FilterResultToChangedLinesOptions,
): RunResult {
  return {
    ...result,
    diagnostics: result.diagnostics.filter((diagnostic) => {
      if (diagnostic.loc === undefined) {
        return true
      }

      const path = normalizePath(options.cwd, diagnostic.filePath)
      const ranges = options.changedLines.get(path)

      if (ranges === undefined) {
        return false
      }

      const startLine = diagnostic.loc.start.line
      const endLine = diagnostic.loc.end?.line ?? startLine

      return ranges.some(range => startLine <= range.endLine && endLine >= range.startLine)
    }),
  }
}

function normalizePath(cwd: string, filePath: string): string {
  const path = isAbsolute(filePath) ? relative(cwd, filePath) : filePath
  return path.replaceAll('\\', '/')
}
