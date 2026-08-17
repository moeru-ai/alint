import { describe, expect, it } from 'vitest'

import { isNodeErrorCode } from './node'

describe('isNodeErrorCode', () => {
  it('matches the code on a Node error', () => {
    const error = Object.assign(new Error('Missing file'), { code: 'ENOENT' })

    expect(isNodeErrorCode(error, 'ENOENT')).toBe(true)
  })

  it('rejects other values and codes', () => {
    expect(isNodeErrorCode(new Error('Missing file'), 'ENOENT')).toBe(false)
    expect(isNodeErrorCode({ code: 'ENOENT' }, 'ENOENT')).toBe(false)
    expect(isNodeErrorCode(Object.assign(new Error('Missing file'), { code: 'ENOENT' }), 'EACCES')).toBe(false)
  })
})
