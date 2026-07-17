import type { AgentAdapter, AgentRequest, AgentResult } from './types'

import { withRetry } from '@moeru/std/with-retry'

export interface AgentRetryOptions {
  onRetry?: (payload: { attempt: number, maxAttempts: number }) => void
}

type AgentAttempt
  = | { error: unknown, ok: false }
    | { ok: true, result: AgentResult }

/**
 * Declares that the complete adapter invocation can be safely replayed.
 * Adapters must not throw this after a tool or another externally visible side effect starts.
 */
export class RetryableAgentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RetryableAgentError'
  }
}

export function isRetryableAgentError(error: unknown): error is RetryableAgentError {
  return error instanceof RetryableAgentError
}

export function withAgentRetry(adapter: AgentAdapter, retries = 2, options: AgentRetryOptions = {}): AgentAdapter {
  return async (request) => {
    let invocation = 0
    // TODO(agent-retry-abort): make retry backoff immediately abortable once
    // @moeru/std/with-retry supports AbortSignal.
    const invoke = withRetry(async (request: AgentRequest): Promise<AgentAttempt> => {
      const attempt = invocation
      invocation += 1

      try {
        request.signal?.throwIfAborted()
        if (attempt > 0)
          options.onRetry?.({ attempt, maxAttempts: retries + 1 })
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
      retry: retries,
      retryDelay: 500,
      retryDelayFactor: 2,
      retryDelayMax: 30_000,
    })

    const attempt = await invoke(request)
    if (!attempt.ok)
      throw attempt.error
    return attempt.result
  }
}
