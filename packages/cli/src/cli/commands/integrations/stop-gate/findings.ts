import type { Diagnostic } from '@alint-js/core'

import { stableHash } from '@alint-js/core'

export function fingerprintDiagnostics(diagnostics: readonly Diagnostic[]): string {
  const diagnosticHashes = diagnostics
    .map(diagnostic => stableHash({
      evidence: diagnostic.evidence,
      filePath: diagnostic.filePath,
      loc: diagnostic.loc,
      message: diagnostic.message,
      ruleId: diagnostic.ruleId,
      severity: diagnostic.severity,
    }))
    // The fingerprint represents a multiset: order is irrelevant, while duplicate hashes remain.
    .sort()

  return stableHash({
    diagnosticHashes,
    schemaVersion: 1,
  })
}
