import { describe, expect, it } from 'vitest'

import { createStableHasher, hashText, stableHash } from './hash'

describe('canonical hashing', () => {
  it('ignores object property insertion order', () => {
    const expected = '43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777'

    expect(stableHash({ a: 1, b: 2 })).toBe(expected)
    // The reversed keys are the behavior under test.
    // eslint-disable-next-line perfectionist/sort-objects
    expect(stableHash({ b: 2, a: 1 })).toBe(expected)
  })

  it('frames incremental values without concatenation ambiguity', () => {
    const firstHasher = createStableHasher()
    const secondHasher = createStableHasher()

    expect(firstHasher.update(1)).toBe(firstHasher)
    expect(secondHasher.update(12)).toBe(secondHasher)

    const first = firstHasher.update(23).digest()
    const second = secondHasher.update(3).digest()

    expect(first).not.toBe(second)
  })

  it('keeps text hashing output stable', () => {
    expect(hashText('alint canonical hashing'))
      .toBe('f11633493dec3b38611cbc39d2cfde42d8c444d8f3b70144dbb7300034fb9075')
  })

  it('omits undefined object properties', () => {
    expect(stableHash({ a: 1, omitted: undefined }))
      .toBe('015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862')
  })

  it('keeps nested object and array hashing output stable', () => {
    expect(stableHash({
      nested: { a: 1, b: 2 },
      values: [1, 'two', null],
    })).toBe('e8e737349aee122f65fe166fdfb0ca58ac85672b3e1073587c0bad2c52d93631')
  })
})
