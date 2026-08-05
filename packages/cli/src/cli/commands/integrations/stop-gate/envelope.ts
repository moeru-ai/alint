export interface StopGateEnvelope {
  errorCount: number
  findingsHash?: string
  message?: string
  reportPath?: string
  schemaVersion: 2
  status: StopGateStatus
  warningCount: number
}

export type StopGateStatus
  = | 'clean'
    | 'errors'
    | 'inactive'
    | 'no-dirty-files'
    | 'runtime-error'
    | 'warnings'

export function writeEnvelope(
  write: (chunk: string) => unknown,
  envelope: StopGateEnvelope,
): void {
  write(`${JSON.stringify(envelope)}\n`)
}
