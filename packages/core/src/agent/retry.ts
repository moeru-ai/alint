import type { AgentAdapter, AgentRequest, AgentResult } from './types'

import { withRetry } from '@moeru/std/with-retry'

type AgentAttempt
  = | { error: unknown, ok: false }
    | { ok: true, result: AgentResult }

const defaultAgentRetries = 2

export class RetryableAgentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RetryableAgentError'
  }
}

export function isRetryableAgentError(error: unknown): error is RetryableAgentError {
  return error instanceof RetryableAgentError
}

export function resolveAgentRetries(value: number | undefined): number {
  const retries = value ?? defaultAgentRetries
  if (!Number.isInteger(retries) || retries < 0)
    throw new TypeError('Agent retries must be a non-negative integer.')
  return retries
}

export function withAgentRetry(adapter: AgentAdapter, retries: number): AgentAdapter {
  const retry = resolveAgentRetries(retries)

  // TODO(agent-retry-abort): make retry backoff immediately abortable once
  // @moeru/std/with-retry supports AbortSignal.
  const invoke = withRetry(async (request: AgentRequest): Promise<AgentAttempt> => {
    try {
      request.signal?.throwIfAborted()
      const result = await adapter(request)
      request.signal?.throwIfAborted()
      return { ok: true, result }
    }
    catch (error) {
      if (request.signal?.aborted)
        return { error: request.signal.reason, ok: false }
      if (isRetryableAgentError(error))
        throw error
      return { error, ok: false }
    }
  }, {
    retry,
    retryDelay: 500,
    retryDelayFactor: 2,
    retryDelayMax: 30_000,
  })

  return async (request) => {
    const attempt = await invoke(request)
    if (!attempt.ok)
      throw attempt.error
    return attempt.result
  }
}
