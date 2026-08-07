import type { HookDecision, SessionState, StopGateEnvelope } from './types'

const maximumLintRounds = 9

export interface AppliedResult {
  decision: HookDecision
  state: SessionState
}

export function applyResult(
  state: SessionState,
  envelope: StopGateEnvelope,
  now: Date = new Date(),
): AppliedResult {
  if (envelope.status === 'inactive' || envelope.status === 'no-dirty-files') {
    return {
      decision: {},
      state: envelope.status === 'inactive'
        ? updateState(state, now, { lastFindings: undefined, lintRounds: 0, runtimeFailures: 0 })
        : updateState(state, now, { lastFindings: undefined, runtimeFailures: 0 }),
    }
  }

  if (envelope.status === 'runtime-error') {
    const next = updateState(state, now, {
      lastFindings: undefined,
      runtimeFailures: state.runtimeFailures + 1,
    })
    return {
      decision: next.runtimeFailures === 1
        ? { decision: 'block', reason: runtimeFailureMessage(envelope.message) }
        : { systemMessage: runtimeFailureMessage(envelope.message) },
      state: next,
    }
  }

  const lintRounds = state.lintRounds + 1
  const repeatedFindings = envelope.status === 'errors' || envelope.status === 'warnings'
    ? state.lastFindings?.findingsHash === envelope.findingsHash
    : false
  const next = updateState(state, now, {
    lastFindings: envelope.status === 'errors' || envelope.status === 'warnings'
      ? {
          errorCount: envelope.errorCount,
          findingsHash: envelope.findingsHash,
          reportPath: envelope.reportPath,
          status: envelope.status,
          warningCount: envelope.warningCount,
        }
      : undefined,
    lintRounds,
    runtimeFailures: 0,
  })

  if (envelope.status === 'clean') {
    return { decision: {}, state: next }
  }

  const message = findingMessage(next, envelope.reportPath)
  const shouldBlock = envelope.status === 'errors'
    ? lintRounds < maximumLintRounds && !repeatedFindings
    : lintRounds === 1

  return {
    decision: shouldBlock
      ? { decision: 'block', reason: message }
      : {
          systemMessage: repeatedFindings
            ? repeatedFindingsMessage(next, envelope.reportPath)
            : message,
        },
    state: next,
  }
}

export function hasReachedLintLimit(state: SessionState): boolean {
  return state.lintRounds >= maximumLintRounds
}

export function lintLimitDecision(state: SessionState): HookDecision {
  if (state.lastFindings === undefined) {
    return {}
  }

  return {
    systemMessage: findingMessage(state, state.lastFindings.reportPath),
  }
}

export function runtimeFailureMessage(message: string): string {
  return `alint-plugin: Stop Gate failed -- Do not attempt to fix it yourself; Tell the user to resolve the following error: ${message}`
}

function findingMessage(state: SessionState, reportPath: string): string {
  const findings = state.lastFindings

  if (findings === undefined) {
    return ''
  }

  const findingKind = findings.status === 'warnings' ? 'warnings' : 'errors'

  return `alint-plugin: ${findings.errorCount} error(s), ${findings.warningCount} warning(s). Review the report at "${reportPath}" carefully. Act only on findings that are valid, valuable, and relevant to the current uncommitted changes. Do not make opportunistic changes merely to silence findings, such as deleting code, ignoring files, disabling rules, or changing the alint configuration. If you determine that none of the reported ${findingKind} are valid or valuable, tell the user that the alint configuration may need to be revised, but do not change it yourself.`
}

function repeatedFindingsMessage(state: SessionState, reportPath: string): string {
  const findings = state.lastFindings

  if (findings === undefined) {
    return ''
  }

  return `alint-plugin: The same ${findings.errorCount} error(s) and ${findings.warningCount} warning(s) remain unchanged from the previous automatic lint. Stop Gate is allowing this turn to finish. The report remains at "${reportPath}".`
}

function updateState(
  state: SessionState,
  now: Date,
  patch: Partial<SessionState>,
): SessionState {
  return {
    ...state,
    ...patch,
    schemaVersion: 2,
    updatedAt: now.toISOString(),
  }
}
