import type { AlintRunCancelledError, AlintRunError, AlintRunFailure } from '@alint-js/core'

import { createColors } from 'tinyrainbow'

const colors = createColors({ force: true })

export function formatCancelledError(error: AlintRunCancelledError, color: boolean): string {
  const label = color ? colors.red('error') : 'error'
  return `${label} ${error.message}\n`
}

export function formatRunError(error: AlintRunError, color: boolean): string {
  const label = color ? colors.red('error') : 'error'
  const lines = [
    `${label} ${error.message}`,
    ...error.failures.map(formatFailure),
    '',
  ]

  return lines.join('\n')
}

function formatFailure(failure: AlintRunFailure): string {
  const target = failure.job.target.name
    ? `${failure.job.target.kind} ${failure.job.target.name}`
    : failure.job.target.kind

  return `  [${failure.kind}] ${failure.job.inputPath} > ${target} > ${failure.job.ruleId}: ${failure.message}`
}
