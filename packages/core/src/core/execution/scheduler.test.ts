import { describe, expect, it } from 'vitest'

import { runWithConcurrency } from './scheduler'

describe('runWithConcurrency', () => {
  it('never exceeds the concurrency limit', async () => {
    let active = 0
    let maxActive = 0
    const gates = Array.from({ length: 8 }, () => deferred<void>())

    const running = runWithConcurrency(gates.map((gate, index) => async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await gate.promise
      active -= 1
      return index
    }), 3)

    await waitFor(() => active === 3)
    expect(maxActive).toBe(3)
    for (const gate of gates)
      gate.resolve()

    await expect(running).resolves.toHaveLength(8)
    expect(maxActive).toBe(3)
  })

  it('returns results in input order', async () => {
    const gates = Array.from({ length: 3 }, () => deferred<string>())
    const running = runWithConcurrency(gates.map(gate => () => gate.promise), 3)

    gates[2]!.resolve('third')
    gates[0]!.resolve('first')
    gates[1]!.resolve('second')

    await expect(running).resolves.toEqual(['first', 'second', 'third'])
  })

  it('drains every task before rejecting an unexpected error', async () => {
    const active = deferred<string>()
    const infrastructureError = new Error('executor crashed')
    const settled: string[] = []

    const running = runWithConcurrency([
      async () => {
        await Promise.resolve()
        throw infrastructureError
      },
      async () => {
        const value = await active.promise
        settled.push(value)
        return value
      },
      async () => {
        settled.push('queued')
        return 'queued'
      },
    ], 2)

    await Promise.resolve()
    active.resolve('active')

    await expect(running).rejects.toBe(infrastructureError)
    expect(new Set(settled)).toEqual(new Set(['active', 'queued']))
  })

  it('resolves an empty task list', async () => {
    await expect(runWithConcurrency([], 4)).resolves.toEqual([])
  })

  it.each([0, 1.5, Number.NaN])('rejects invalid concurrency %s', async (concurrency) => {
    await expect(runWithConcurrency([], concurrency)).rejects.toBeInstanceOf(TypeError)
  })
})

function deferred<T>(): { promise: Promise<T>, resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate())
      return
    await Promise.resolve()
  }
  throw new Error('Condition was not reached')
}
