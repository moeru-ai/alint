import { afterEach, describe, expect, it, vi } from 'vitest'

import { createTimeoutSignal } from './timeout'

describe('stop Gate timeout signal', () => {
  afterEach(() => vi.useRealTimers())

  it('chunks waits beyond the Node timer limit without aborting early', async () => {
    vi.useFakeTimers()
    const timeout = createTimeoutSignal(2_147_483_647 + 10)

    await vi.advanceTimersByTimeAsync(2_147_483_647)
    expect(timeout.signal.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(10)
    expect(timeout.signal.aborted).toBe(true)
  })
})
