import type { AlintRunCancelledError, AlintRunError, AlintRunFailure } from '@alint-js/core'

import { createColors } from 'tinyrainbow'

const colors = createColors({ force: true })

export function formatCancelledError(error: AlintRunCancelledError, color: boolean): string {
  const label = color ? colors.red('error') : 'error'
  return `${label} ${error.message}\n`
}

export function formatRunError(error: AlintRunError, color: boolean): string {
  const label = color ? colors.red('error') : 'error'
  const groups = groupFailuresByRule(error.failures)
  const lines = [
    `${label} ${error.message}`,
    '',
    `Failed Rules ${groups.length}`,
    '',
    ...formatFailureGroups(groups, color),
  ]

  return lines.join('\n')
}

function formatFailureGroups(groups: Array<[string, AlintRunFailure[]]>, color: boolean): string[] {
  const lines: string[] = []
  for (const [ruleId, group] of groups) {
    const failLabel = color ? colors.bgRed(colors.bold(' FAIL ')) : 'FAIL'
    const targetLabel = group.length === 1 ? 'target' : 'targets'
    lines.push(`${failLabel} ${ruleId} ${group.length} ${targetLabel}`)
    for (const failure of group.sort((left, right) => left.job.index - right.job.index)) {
      lines.push(`  ${formatTarget(failure)}`)
      lines.push(`    [${failure.kind}] ${failure.message}`)
    }
    lines.push('')
  }
  return lines
}

function formatTarget(failure: AlintRunFailure): string {
  const target = failure.job.target.name
    ? `${failure.job.target.kind} ${failure.job.target.name}`
    : failure.job.target.kind

  return `${failure.job.inputPath} > ${target}`
}

function groupFailuresByRule(failures: AlintRunFailure[]): Array<[string, AlintRunFailure[]]> {
  const groups = new Map<string, AlintRunFailure[]>()
  for (const failure of failures) {
    const group = groups.get(failure.job.ruleId) ?? []
    group.push(failure)
    groups.set(failure.job.ruleId, group)
  }

  return [...groups]
}
