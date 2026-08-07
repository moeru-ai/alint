export type StopGateEnvelope
  = | StopGateEnvelopeBase & {
    findingsHash: string
    reportPath: string
    status: 'errors' | 'warnings'
  }
  | StopGateEnvelopeBase & {
    message: string
    status: 'runtime-error'
  }
  | StopGateEnvelopeBase & {
    status: 'clean'
  }
  | StopGateEnvelopeBase & {
    status: 'inactive'
  }
  | StopGateEnvelopeBase & {
    status: 'no-dirty-files'
  }

interface StopGateEnvelopeBase {
  errorCount: number
  schemaVersion: 2
  warningCount: number
}

export function writeEnvelope(
  write: (chunk: string) => unknown,
  envelope: StopGateEnvelope,
): void {
  write(`${JSON.stringify(envelope)}\n`)
}
