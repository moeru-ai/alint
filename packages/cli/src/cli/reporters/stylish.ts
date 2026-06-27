import type { Diagnostic, RunResult } from '@alint-js/core'

import { createColors } from 'tinyrainbow'

const colors = createColors({ force: true })

export interface StylishReporterOptions {
  color?: boolean
}

export function formatStylish(input: Diagnostic[] | RunResult, options: StylishReporterOptions = {}): string {
  const diagnostics = Array.isArray(input) ? input : input.diagnostics
  const totalTokens = Array.isArray(input) ? undefined : input.usage.totalTokens

  if (diagnostics.length === 0)
    return ''

  const diagnosticsByFile = new Map<string, Diagnostic[]>()

  for (const diagnostic of diagnostics) {
    const fileDiagnostics = diagnosticsByFile.get(diagnostic.filePath)

    if (fileDiagnostics) {
      fileDiagnostics.push(diagnostic)
      continue
    }

    diagnosticsByFile.set(diagnostic.filePath, [diagnostic])
  }

  const lines: string[] = []
  const style = createStyle(options.color === true)

  for (const [filePath, fileDiagnostics] of diagnosticsByFile) {
    lines.push(style.file(filePath))

    for (const diagnostic of fileDiagnostics) {
      const line = diagnostic.loc?.start.line ?? 0
      const column = diagnostic.loc?.start.column ?? 0
      const severity = diagnostic.severity === 'warn'
        ? style.warning('warning')
        : style.error('error')

      lines.push(`  ${style.location(`${line}:${column}`)}  ${severity}  ${diagnostic.message}  ${style.ruleId(diagnostic.ruleId)}`)
    }

    lines.push('')
  }

  lines.push('', formatSummary(diagnostics, totalTokens, style))

  return `${lines.join('\n')}\n`
}

function countDiagnostics(diagnostics: Diagnostic[], severity: Diagnostic['severity']): number {
  return diagnostics.filter(diagnostic => diagnostic.severity === severity).length
}

function createStyle(color: boolean) {
  if (!color) {
    return {
      error: identity,
      file: identity,
      location: identity,
      ruleId: identity,
      summaryToken: identity,
      warning: identity,
    }
  }

  return {
    error: colors.red,
    file: colors.underline,
    location: colors.dim,
    ruleId: colors.dim,
    summaryToken: colors.cyan,
    warning: colors.yellow,
  }
}

function formatSummary(
  diagnostics: Diagnostic[],
  totalTokens: number | undefined,
  style: ReturnType<typeof createStyle>,
): string {
  const warnCount = countDiagnostics(diagnostics, 'warn')
  const errorCount = countDiagnostics(diagnostics, 'error')
  const tokens = totalTokens === undefined
    ? undefined
    : `${totalTokens.toLocaleString('en-US')} tokens`
  const problemSummary = [
    style.warning(`${warnCount} warn`),
    style.error(`${errorCount} error`),
  ].join(' / ')

  if (tokens === undefined) {
    return problemSummary
  }

  return `${problemSummary} | ${style.summaryToken(tokens)}`
}

function identity(value: string): string {
  return value
}
