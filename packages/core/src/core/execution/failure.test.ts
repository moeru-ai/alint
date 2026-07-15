import type { AlintRunFailure } from '../types'

import { describe, expect, it } from 'vitest'

import { selectTerminalFailure } from './failure'

describe('terminal run failure precedence', () => {
  it('keeps ordered rule failures while selecting an exact infrastructure cause', () => {
    const cause = { infrastructure: true }
    const failures = [failure(2), failure(5)]

    const selected = selectTerminalFailure({
      cancellationCause: undefined,
      cancelled: false,
      failedOutcomeCauses: [new Error('rule 2'), new Error('rule 5')],
      failures,
      infrastructureCause: cause,
      infrastructureFailed: true,
      progressCause: undefined,
      progressFailed: false,
    })

    expect(selected).toEqual({ cause, failures, kind: 'infrastructure' })
    expect(selected?.failures).toBe(failures)
  })

  it('filters undefined aggregate causes without dropping their rule failures', () => {
    const definedCause = new Error('defined')
    const failures = [failure(1), failure(3)]

    const selected = selectTerminalFailure({
      cancellationCause: undefined,
      cancelled: false,
      failedOutcomeCauses: [undefined, definedCause],
      failures,
      infrastructureCause: undefined,
      infrastructureFailed: false,
      progressCause: undefined,
      progressFailed: false,
    })

    expect(selected).toEqual({ causes: [definedCause], failures, kind: 'rules' })
    expect(selected?.failures).toHaveLength(2)
  })
})

function failure(index: number): AlintRunFailure {
  return {
    kind: 'handler',
    message: `failure ${index}`,
    path: {
      job: { index, total: 8 },
      plan: { id: 'plan', index: 1, kind: 'source', path: '/repo/a.ts', planned: 8, total: 1 },
      rule: { id: `rule:${index}`, index, total: 8 },
      target: { identity: 'file', index: 1, kind: 'file', total: 1 },
    },
  }
}
