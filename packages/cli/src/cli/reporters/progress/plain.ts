import type {
  Diagnostic,
  ProgressReporter,
  RuleStartPayload,
  RunEndPayload,
  RunStartPayload,
} from '@alint-js/core'

export interface PlainProgressReporterOptions {
  write: (chunk: string) => void
}

export function createPlainProgressReporter(options: PlainProgressReporterOptions): ProgressReporter {
  const writeLine = (line: string) => options.write(`${line}\n`)

  return {
    onRuleStart: (payload: RuleStartPayload) => {
      const target = payload.path.target.name
        ? `${payload.path.target.kind} ${payload.path.target.name}`
        : payload.path.target.kind

      writeLine(`scan ${payload.path.plan.path} > ${target} > ${payload.path.rule.id}`)
    },
    onRunEnd: (payload: RunEndPayload) => {
      const warnCount = countDiagnostics(payload.diagnostics, 'warn')
      const errorCount = countDiagnostics(payload.diagnostics, 'error')
      const state = payload.execution.failed > 0 ? 'failed' : 'finished'
      const { cached, cancelled, completed, failed, skipped } = payload.execution

      writeLine(`alint ${state}: ${warnCount} warn, ${errorCount} error, ${payload.usage.totalTokens} tokens, ${completed} completed, ${cached} cached, ${failed} failed, ${cancelled} cancelled, ${skipped} skipped`)
    },
    onRunStart: (payload: RunStartPayload) => {
      writeLine(`alint started: ${payload.plans.length} plans, ${payload.rulesTotal} rules, ${payload.execution.planned} planned executions`)
    },
  }
}

function countDiagnostics(diagnostics: Diagnostic[], severity: Diagnostic['severity']): number {
  return diagnostics.filter(diagnostic => diagnostic.severity === severity).length
}
