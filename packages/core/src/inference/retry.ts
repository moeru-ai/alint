export interface InferenceRetryPolicy {
  maxRetries: number
  retryDelay: (retry: number, response?: Response) => number
}

export interface RetryingFetchOptions {
  fetch?: typeof globalThis.fetch
  policy?: Partial<InferenceRetryPolicy>
}

const MAX_RETRY_DELAY = 30_000
const TRANSIENT_ERROR_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
])

export const defaultInferenceRetryPolicy: InferenceRetryPolicy = {
  maxRetries: 2,
  retryDelay(retry, response) {
    const serverDelay = retryDelayFrom(response)
    const exponentialDelay = 500 * 2 ** Math.max(0, retry - 1)
    return Math.min(serverDelay ?? exponentialDelay, MAX_RETRY_DELAY)
  },
}

export function createRetryingFetch(options: RetryingFetchOptions = {}): typeof globalThis.fetch {
  const fetch = options.fetch ?? globalThis.fetch
  const policy: InferenceRetryPolicy = {
    ...defaultInferenceRetryPolicy,
    ...options.policy,
  }

  validateMaxRetries(policy.maxRetries)

  return async (input, init) => {
    const signal = effectiveSignal(input, init)
    const replayable = isReplayable(input, init)

    for (let retry = 0; ; retry += 1) {
      throwIfAborted(signal)

      let response: Response
      try {
        response = await fetch(input, init)
      }
      catch (error) {
        if (!replayable || retry >= policy.maxRetries || signal?.aborted || !isTransientInferenceError(error))
          throw error

        const delay = policy.retryDelay(retry + 1)
        validateRetryDelay(delay)
        await wait(delay, signal)
        continue
      }

      if (!replayable || retry >= policy.maxRetries || !isTransientStatus(response.status))
        return response

      // A response being retried is never exposed to the caller, so release its
      // connection before waiting and issuing the next provider request.
      try {
        await response.body?.cancel()
      }
      catch {
        // Cancellation is best-effort; the retry result remains authoritative.
      }

      const delay = policy.retryDelay(retry + 1, response)
      validateRetryDelay(delay)
      await wait(delay, signal)
    }
  }
}

export function isTransientInferenceError(error: unknown): boolean {
  const seen = new Set<object>()
  let candidate: unknown = error
  let transient = false

  while (isObject(candidate) && !seen.has(candidate)) {
    seen.add(candidate)

    const name = property(candidate, 'name')
    if (name === 'AbortError')
      return false
    if (name === 'TimeoutError')
      transient = true

    const code = property(candidate, 'code')
    if (typeof code === 'string' && TRANSIENT_ERROR_CODES.has(code))
      transient = true

    const statusCode = property(candidate, 'statusCode')
    if (typeof statusCode === 'number' && isTransientStatus(statusCode))
      transient = true

    candidate = property(candidate, 'cause')
  }

  return transient
}

function effectiveSignal(input: RequestInfo | URL, init: RequestInit | undefined): AbortSignal | undefined {
  if (init?.signal)
    return init.signal
  return isRequest(input) ? input.signal : undefined
}

function isObject(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

function isReplayable(input: RequestInfo | URL, init: RequestInit | undefined): boolean {
  if (isRequest(input) && input.body !== null)
    return false
  return typeof ReadableStream === 'undefined' || !(init?.body instanceof ReadableStream)
}

function isRequest(input: RequestInfo | URL): input is Request {
  return typeof Request !== 'undefined' && input instanceof Request
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

function property(value: object, key: string): unknown {
  try {
    return Reflect.get(value, key)
  }
  catch {
    return undefined
  }
}

function retryDelayFrom(response: Response | undefined): number | undefined {
  if (!response)
    return undefined

  const retryAfterMilliseconds = response.headers.get('retry-after-ms')
  if (retryAfterMilliseconds !== null) {
    const delay = Number(retryAfterMilliseconds)
    if (Number.isFinite(delay) && delay >= 0)
      return delay
  }

  const retryAfter = response.headers.get('retry-after')
  if (retryAfter === null)
    return undefined

  const seconds = Number(retryAfter)
  if (Number.isFinite(seconds) && seconds >= 0)
    return seconds * 1_000

  const date = Date.parse(retryAfter)
  if (!Number.isNaN(date))
    return Math.max(0, date - Date.now())

  return undefined
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted)
    throw signal.reason
}

function validateMaxRetries(maxRetries: number): void {
  if (!Number.isInteger(maxRetries) || maxRetries < 0)
    throw new TypeError('maxRetries must be a nonnegative integer')
}

function validateRetryDelay(delay: number): void {
  if (!Number.isFinite(delay) || delay < 0)
    throw new TypeError('retryDelay must return a nonnegative finite number')
}

function wait(delay: number, signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal)

  if (delay === 0)
    return Promise.resolve()

  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = () => {
      if (timer)
        clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(signal?.reason)
    }
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delay)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted)
      onAbort()
  })
}
