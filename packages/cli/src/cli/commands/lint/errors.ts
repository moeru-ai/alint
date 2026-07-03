import type { AlintRunError } from '@alint-js/core'

import c from 'tinyrainbow'

export function formatRunError(error: AlintRunError, color: boolean): string {
  const label = color ? c.red('error') : 'error'
  const context = formatRunErrorContext(error)
  const message = error.failure?.message ?? error.message

  return `${label} ${context}\n  Rule running failed due to ${message}\n`
}

function formatRunErrorContext(error: AlintRunError): string {
  const failure = error.failure

  if (!failure) {
    return 'alint run failed'
  }

  const target = failure.target
    ? failure.target.name
      ? `${failure.target.kind} ${failure.target.name}`
      : failure.target.kind
    : undefined

  return [
    failure.filePath,
    target,
    failure.ruleId,
  ].filter(Boolean).join(' > ')
}
