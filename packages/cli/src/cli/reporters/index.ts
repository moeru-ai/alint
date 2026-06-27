import type { RunResult } from '@alint-js/core'

import { formatJson } from './json'
import { formatStylish } from './stylish'

export interface FormatDiagnosticsOptions {
  color?: boolean
}

export type ReporterName = 'json' | 'stylish'

export function formatDiagnostics(
  format: ReporterName,
  result: RunResult,
  options: FormatDiagnosticsOptions = {},
): string {
  if (format === 'json')
    return formatJson(result)

  if (format === 'stylish')
    return formatStylish(result, { color: options.color })

  throw new Error(`Unknown reporter "${format}".`)
}
