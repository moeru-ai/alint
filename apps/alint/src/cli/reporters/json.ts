import type { RunAlintResult } from '../../core/types'

export function formatJson(result: RunAlintResult): string {
  return `${JSON.stringify(result, null, 2)}\n`
}
