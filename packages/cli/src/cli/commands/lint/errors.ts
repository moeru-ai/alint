import type { AlintRunCancelledError, AlintRunError, AlintRunFailure } from '@alint-js/core'

import { AlintProgressError } from '@alint-js/core'
import { errorMessageFrom } from '@moeru/std/error'
import { createColors } from 'tinyrainbow'

type FormattableRunError = AlintProgressError | AlintRunError
const colors = createColors({ force: true })

export function formatCancelledError(error: AlintRunCancelledError, color: boolean): string {
  const label = color ? colors.red('error') : 'error'
  return `${label} ${error.message}\n`
}

export function formatRunError(error: FormattableRunError, color: boolean): string {
  const label = color ? colors.red('error') : 'error'
  const isProgressError = error instanceof AlintProgressError
  const causeMessage = isProgressError ? errorMessageFrom(error.cause) ?? String(error.cause) : undefined
  const lines = [
    `${label} ${error.message}`,
    ...(isProgressError ? [`  infrastructure: ${causeMessage}`] : []),
    ...error.failures.map(formatFailure),
    '',
  ]

  return lines.join('\n')
}

function formatFailure(failure: AlintRunFailure): string {
  const target = failure.path.target.name
    ? `${failure.path.target.kind} ${failure.path.target.name}`
    : failure.path.target.kind

  return `  [${failure.kind}] ${failure.path.plan.path} > ${target} > ${failure.path.rule.id}: ${failure.message}`
}
