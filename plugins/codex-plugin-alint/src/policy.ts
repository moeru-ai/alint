import type { HookDecision, SessionState, StopGateEnvelope } from './types'

export const maximumLintRounds = 9

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
    const message = `alint-plugin: Stop Gate failed -- Do not attempt to fix it yourself; Tell the user to resolve the following error: ${envelope.message}`
    return {
      decision: next.runtimeFailures === 1
        ? { decision: 'block', reason: message }
        : { systemMessage: message },
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

  const message = next.lastFindings === undefined || envelope.reportPath === undefined
    ? ''
    : repeatedFindings
      ? `alint-plugin: The same ${next.lastFindings.errorCount} error(s) and ${next.lastFindings.warningCount} warning(s) remain unchanged from the previous automatic lint. Stop Gate is allowing this turn to finish. The report remains at "${envelope.reportPath}".`
      : `alint-plugin: ${next.lastFindings.errorCount} error(s), ${next.lastFindings.warningCount} warning(s). Review the report at "${envelope.reportPath}" carefully. Act only on findings that are valid, valuable, and relevant to the current uncommitted changes. Do not make opportunistic changes merely to silence findings, such as deleting code, ignoring files, disabling rules, or changing the alint configuration. If you determine that none of reports are valid or valuable, just do nothing, next time the gate will allowing this turn to finish.`
  const shouldBlock = envelope.status === 'errors'
    ? lintRounds < maximumLintRounds && !repeatedFindings
    : lintRounds === 1

  return {
    decision: shouldBlock
      ? { decision: 'block', reason: message }
      : { systemMessage: message },
    state: next,
  }
}

export function lintLimitDecision(state: SessionState): HookDecision {
  return {
    systemMessage: state.lastFindings === undefined
      ? ''
      : `alint-plugin: ${state.lastFindings.errorCount} error(s), ${state.lastFindings.warningCount} warning(s). Review the report at "${state.lastFindings.reportPath}" carefully. Act only on findings that are valid, valuable, and relevant to the current uncommitted changes. Do not make opportunistic changes merely to silence findings, such as deleting code, ignoring files, disabling rules, or changing the alint configuration. If you determine that none of reports are valid or valuable, just do nothing, next time the gate will allowing this turn to finish.`,
  }
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
