export interface MiniBarOptions {
  completed: number
  planned: number
  tick: number
  width: number
}

const minBarWidth = 4
const maxBarWidth = 16
const animationThreshold = 0.4

export function formatMiniBar(options: MiniBarOptions): string {
  if (options.planned <= 0 || options.width < minBarWidth)
    return ''

  const width = Math.min(Math.max(Math.floor(options.width), minBarWidth), maxBarWidth)
  const ratio = Math.min(Math.max(options.completed / options.planned, 0), 1)
  const completeCells = Math.min(Math.floor(ratio * width), width)
  const pendingCells = width - completeCells

  if (pendingCells === 0)
    return `[${'█'.repeat(width)}]`

  if (ratio < animationThreshold)
    return formatStaticBar(completeCells, width)

  const frontierIndex = completeCells
  const phase = positiveModulo(options.tick, frontierIndex + 2)

  if (phase === frontierIndex + 1)
    return formatStaticBar(completeCells, width)

  const cells = Array.from({ length: width }, (_, index) => {
    if (phase === 0) {
      if (index === 0)
        return '▓'
      if (index <= frontierIndex)
        return '█'
      return '░'
    }

    if (index < phase - 1)
      return '█'
    if (index === phase - 1)
      return '░'
    if (index === phase)
      return '▓'
    if (index <= frontierIndex)
      return '█'
    return '░'
  })

  return `[${cells.join('')}]`
}

function formatStaticBar(completeCells: number, width: number): string {
  return `[${'█'.repeat(completeCells)}${'░'.repeat(width - completeCells)}]`
}

function positiveModulo(value: number, divisor: number): number {
  return ((Math.floor(value) % divisor) + divisor) % divisor
}
