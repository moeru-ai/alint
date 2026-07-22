import type { AlintRunFailure, Diagnostic, InferenceUsageRecord, ProgressJob } from '../types'

export function snapshotDiagnostic(diagnostic: Diagnostic): Diagnostic {
  const snapshot = { ...diagnostic }
  if (diagnostic.loc) {
    snapshot.loc = {
      ...(diagnostic.loc.end ? { end: { ...diagnostic.loc.end } } : {}),
      start: { ...diagnostic.loc.start },
    }
  }
  if (diagnostic.model)
    snapshot.model = { ...diagnostic.model }

  // evidence is intentionally retained as the rule-owned public output payload.
  return snapshot
}

export function snapshotDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  return diagnostics.map(snapshotDiagnostic)
}

export function snapshotFailure(failure: AlintRunFailure): AlintRunFailure {
  return {
    job: snapshotProgressJob(failure.job),
    kind: failure.kind,
    message: failure.message,
  }
}

export function snapshotProgressJob(job: ProgressJob): ProgressJob {
  return {
    id: job.id,
    index: job.index,
    inputPath: job.inputPath,
    ruleId: job.ruleId,
    ruleIndex: job.ruleIndex,
    ruleTotal: job.ruleTotal,
    target: {
      identity: job.target.identity,
      kind: job.target.kind,
      name: job.target.name,
    },
    total: job.total,
  }
}

export function snapshotUsage(record: InferenceUsageRecord): InferenceUsageRecord {
  // metadata is intentionally retained as the rule-owned public output payload.
  return { ...record }
}

export function snapshotUsageRecords(records: InferenceUsageRecord[]): InferenceUsageRecord[] {
  return records.map(snapshotUsage)
}
