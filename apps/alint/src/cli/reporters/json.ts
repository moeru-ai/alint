import type { RunResult } from '../../core/types'

export function formatJson(result: RunResult): string {
  return `${JSON.stringify(result, null, 2)}\n`
}
