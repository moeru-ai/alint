import type { RunResult } from '@alint-js/core'

export function formatJson(result: RunResult): string {
  return `${JSON.stringify(result, null, 2)}\n`
}
