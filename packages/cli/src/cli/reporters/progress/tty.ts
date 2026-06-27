const clearCurrentLine = '\r\x1B[K'
const clearPreviousLine = '\r\x1B[1A\x1B[K'

export interface TtyProgressRenderer {
  finish: () => void
  render: () => void
  start: () => void
  write: (chunk: string) => void
}

export interface TtyProgressRendererOptions<TInterval = unknown> {
  clearInterval: (interval: TInterval) => void
  createInterval: (callback: () => void, intervalMs: number) => TInterval
  getRows: () => string[]
  intervalMs: number
  write: (chunk: string) => void
}

interface UnrefableInterval {
  unref: () => void
}

export function createTtyProgressRenderer<TInterval>(
  options: TtyProgressRendererOptions<TInterval>,
): TtyProgressRenderer {
  let interval: TInterval | undefined
  let previousRows = 0

  const clearPreviousFrame = () => {
    if (previousRows === 0)
      return

    let sequence = clearCurrentLine

    for (let row = 1; row < previousRows; row += 1) {
      sequence += clearPreviousLine
    }

    options.write(sequence)
    previousRows = 0
  }

  const render = () => {
    clearPreviousFrame()

    const rows = options.getRows()

    if (rows.length === 0)
      return

    options.write(rows.join('\n'))
    previousRows = rows.length
  }

  const write = (chunk: string) => {
    const wasRendering = interval !== undefined

    clearPreviousFrame()
    options.write(chunk)

    if (wasRendering)
      render()
  }

  return {
    finish: () => {
      if (interval) {
        options.clearInterval(interval)
        interval = undefined
      }

      clearPreviousFrame()
    },
    render,
    start: () => {
      if (!interval) {
        interval = options.createInterval(render, options.intervalMs)

        if (isUnrefableInterval(interval))
          interval.unref()
      }

      render()
    },
    write,
  }
}

function isUnrefableInterval(interval: unknown): interval is UnrefableInterval {
  if (typeof interval !== 'object' || interval === null || !('unref' in interval))
    return false

  return typeof interval.unref === 'function'
}
