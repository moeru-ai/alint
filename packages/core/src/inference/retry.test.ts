import { describe, expect, it, vi } from 'vitest'

import {
  createRetryingFetch,
  defaultInferenceRetryPolicy,
  isTransientInferenceError,
} from './retry'

describe('createRetryingFetch', () => {
  it.each([408, 429, 500, 503, 599])('retries HTTP %i and returns the successful response', async (status) => {
    let calls = 0
    const fetch = vi.fn(async () => {
      calls += 1
      return new Response(undefined, { status: calls === 1 ? status : 204 })
    })
    const retryingFetch = createRetryingFetch({
      fetch,
      policy: { retryDelay: () => 0 },
    })

    const response = await retryingFetch('https://example.com')

    expect(response.status).toBe(204)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each([400, 401, 403, 404])('does not retry HTTP %i', async (status) => {
    const fetch = vi.fn(async () => new Response(undefined, { status }))
    const retryingFetch = createRetryingFetch({
      fetch,
      policy: { retryDelay: () => 0 },
    })

    const response = await retryingFetch('https://example.com')

    expect(response.status).toBe(status)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('retries a wrapped connection reset', async () => {
    const connectionReset = Object.assign(new Error('reset'), { code: 'ECONNRESET' })
    const wrappedError = new TypeError('fetch failed', { cause: connectionReset })
    const fetch = vi.fn()
      .mockRejectedValueOnce(wrappedError)
      .mockResolvedValueOnce(new Response(undefined, { status: 204 }))
    const retryingFetch = createRetryingFetch({
      fetch,
      policy: { retryDelay: () => 0 },
    })

    const response = await retryingFetch('https://example.com')

    expect(response.status).toBe(204)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('caps retry-after-ms at 30 seconds', () => {
    const response = new Response(undefined, {
      headers: { 'retry-after-ms': '60000' },
      status: 503,
    })

    expect(defaultInferenceRetryPolicy.retryDelay(1, response)).toBe(30_000)
  })

  it('converts Retry-After seconds to milliseconds', () => {
    const response = new Response(undefined, {
      headers: { 'retry-after': '2' },
      status: 503,
    })

    expect(defaultInferenceRetryPolicy.retryDelay(1, response)).toBe(2_000)
  })

  it('uses 500ms and 1000ms exponential defaults', () => {
    expect(defaultInferenceRetryPolicy.retryDelay(1)).toBe(500)
    expect(defaultInferenceRetryPolicy.retryDelay(2)).toBe(1_000)
  })

  it('rejects with the caller abort reason when aborted during backoff', async () => {
    const controller = new AbortController()
    let notifyFirstCall: (() => void) | undefined
    const firstCall = new Promise<void>((resolve) => {
      notifyFirstCall = resolve
    })
    const fetch = vi.fn(async () => {
      notifyFirstCall?.()
      return new Response(undefined, { status: 503 })
    })
    const retryingFetch = createRetryingFetch({
      fetch,
      policy: { retryDelay: () => 60_000 },
    })
    const request = retryingFetch('https://example.com', { signal: controller.signal })
    await firstCall
    const reason = new Error('stop retrying')

    controller.abort(reason)

    await expect(request).rejects.toBe(reason)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('prefers the caller abort reason when fetch later rejects with a transport error', async () => {
    const controller = new AbortController()
    let rejectFetch: ((error: unknown) => void) | undefined
    const fetch = vi.fn(() => new Promise<Response>((_resolve, reject) => {
      rejectFetch = reject
    }))
    const retryingFetch = createRetryingFetch({
      fetch,
      policy: { retryDelay: () => 0 },
    })
    const request = retryingFetch('https://example.com', { signal: controller.signal })
    const reason = new Error('caller stopped the request')

    controller.abort(reason)
    rejectFetch?.(Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' }))

    await expect(request).rejects.toBe(reason)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('does not replay a ReadableStream request body', async () => {
    const fetch = vi.fn(async () => new Response(undefined, { status: 503 }))
    const retryingFetch = createRetryingFetch({
      fetch,
      policy: { retryDelay: () => 0 },
    })
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1]))
        controller.close()
      },
    })

    const response = await retryingFetch('https://example.com', { body, method: 'POST' })

    expect(response.status).toBe(503)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('does not replay a Request that already has a body', async () => {
    const fetch = vi.fn(async () => new Response(undefined, { status: 503 }))
    const retryingFetch = createRetryingFetch({
      fetch,
      policy: { retryDelay: () => 0 },
    })
    const request = new Request('https://example.com', { body: 'payload', method: 'POST' })

    const response = await retryingFetch(request)

    expect(response.status).toBe(503)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('cancels a transient response body before retrying', async () => {
    let bodyCancelled = false
    const body = new ReadableStream({
      cancel() {
        bodyCancelled = true
      },
    })
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(body, { status: 503 }))
      .mockResolvedValueOnce(new Response(undefined, { status: 204 }))
    const retryingFetch = createRetryingFetch({
      fetch,
      policy: { retryDelay: () => 0 },
    })

    await retryingFetch('https://example.com')

    expect(bodyCancelled).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('returns the last HTTP response after retry exhaustion', async () => {
    const responses = [
      new Response(undefined, { status: 500 }),
      new Response(undefined, { status: 503 }),
      new Response(undefined, { status: 599 }),
    ]
    const fetch = vi.fn(async () => responses.shift()!)
    const retryingFetch = createRetryingFetch({
      fetch,
      policy: { retryDelay: () => 0 },
    })

    const response = await retryingFetch('https://example.com')

    expect(response.status).toBe(599)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('throws the exact final transport error after retry exhaustion', async () => {
    const errors = Array.from({ length: 3 }, (_, index) => Object.assign(
      new TypeError(`failure ${index}`),
      { code: 'ETIMEDOUT' },
    ))
    const finalError = errors.at(-1)
    const fetch = vi.fn(async () => {
      const error = errors.shift()
      if (!error)
        throw new Error('test made more requests than expected')
      throw error
    })
    const retryingFetch = createRetryingFetch({
      fetch,
      policy: { retryDelay: () => 0 },
    })

    await expect(retryingFetch('https://example.com')).rejects.toBe(finalError)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it.each([-1, 1.5])('rejects invalid maxRetries %s synchronously', (maxRetries) => {
    expect(() => createRetryingFetch({ policy: { maxRetries } })).toThrow(TypeError)
  })

  it.each([-1, Number.POSITIVE_INFINITY])('rejects an invalid retry delay %s', async (delay) => {
    const retryingFetch = createRetryingFetch({
      fetch: async () => new Response(undefined, { status: 503 }),
      policy: { retryDelay: () => delay },
    })

    await expect(retryingFetch('https://example.com')).rejects.toThrow(TypeError)
  })
})

describe('isTransientInferenceError', () => {
  it.each([
    'ECONNRESET',
    'EPIPE',
    'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_SOCKET',
  ])('recognizes %s', (code) => {
    expect(isTransientInferenceError(Object.assign(new Error('transport failure'), { code }))).toBe(true)
  })

  it('does not treat a caller-requested AbortError as transient', () => {
    expect(isTransientInferenceError(new DOMException('aborted', 'AbortError'))).toBe(false)
  })

  it('does not classify an error as transient when the caller signal is aborted', () => {
    const controller = new AbortController()
    controller.abort(new Error('caller stopped'))

    expect(isTransientInferenceError(
      Object.assign(new Error('transport failure'), { code: 'ECONNRESET' }),
      { signal: controller.signal },
    )).toBe(false)
  })

  it.each([
    [599, true],
    [600, false],
    [Number.POSITIVE_INFINITY, false],
  ])('classifies statusCode %s as transient: %s', (statusCode, expected) => {
    expect(isTransientInferenceError({ statusCode })).toBe(expected)
  })
})
