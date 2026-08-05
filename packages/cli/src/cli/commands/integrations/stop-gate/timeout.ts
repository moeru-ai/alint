const maximumTimerChunkMs = 2_147_483_647

export interface TimeoutSignal {
  dispose: () => void
  signal: AbortSignal
}

/**
 * Node shortens an overflowing timer to one millisecond. The public Stop Gate limit is currently
 * below that boundary, while chunking here keeps this process-level safety helper correct if the
 * host budget changes independently later.
 */
export function createTimeoutSignal(timeoutMs: number): TimeoutSignal {
  const controller = new AbortController()
  let remainingMs = timeoutMs
  let timer: NodeJS.Timeout | undefined

  const schedule = () => {
    const delay = Math.min(remainingMs, maximumTimerChunkMs)
    timer = setTimeout(() => {
      remainingMs -= delay

      if (remainingMs > 0) {
        schedule()
        return
      }

      controller.abort(new DOMException('Stop Gate timed out.', 'TimeoutError'))
    }, delay)
  }

  schedule()

  return {
    dispose: () => clearTimeout(timer),
    signal: controller.signal,
  }
}
