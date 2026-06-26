import type {
  AlintProgressReporter,
  AlintRuleStartPayload,
  AlintRunEndPayload,
  AlintRunStartPayload,
  Diagnostic,
} from '../../../core/types'

export interface PlainProgressReporterOptions {
  write: (chunk: string) => void
}

export function createPlainProgressReporter(options: PlainProgressReporterOptions): AlintProgressReporter {
  const writeLine = (line: string) => options.write(`${line}\n`)

  return {
    onRuleStart: (payload: AlintRuleStartPayload) => {
      const target = payload.path.target.name
        ? `${payload.path.target.kind} ${payload.path.target.name}`
        : payload.path.target.kind

      writeLine(`scan ${payload.path.file.path} > ${target} > ${payload.path.rule.id}`)
    },
    onRunEnd: (payload: AlintRunEndPayload) => {
      const warnCount = countDiagnostics(payload.diagnostics, 'warn')
      const errorCount = countDiagnostics(payload.diagnostics, 'error')
      const state = payload.errored > 0 ? 'failed' : 'finished'
      const errored = payload.errored > 0 ? `, ${payload.errored} errored` : ''

      writeLine(`alint ${state}: ${warnCount} warn, ${errorCount} error, ${payload.usage.totalTokens} tokens${errored}`)
    },
    onRunStart: (payload: AlintRunStartPayload) => {
      writeLine(`alint started: ${payload.filesTotal} files, ${payload.rulesTotal} rules, ${payload.planned} planned executions`)
    },
  }
}

function countDiagnostics(diagnostics: Diagnostic[], severity: Diagnostic['severity']): number {
  return diagnostics.filter(diagnostic => diagnostic.severity === severity).length
}
