import { describe, expect, it } from 'vitest'

import { isCi } from './ci'

describe('isCi', () => {
  it('is false for an empty env', () => {
    expect(isCi({})).toBe(false)
  })

  it('treats CI=true and CI=1 as CI', () => {
    expect(isCi({ CI: 'true' })).toBe(true)
    expect(isCi({ CI: '1' })).toBe(true)
  })

  it('ignores CI=false, CI=0, and empty CI', () => {
    expect(isCi({ CI: 'false' })).toBe(false)
    expect(isCi({ CI: '0' })).toBe(false)
    expect(isCi({ CI: '' })).toBe(false)
  })

  it('detects provider-specific vars without CI', () => {
    expect(isCi({ GITHUB_ACTIONS: 'true' })).toBe(true)
    expect(isCi({ GITLAB_CI: 'true' })).toBe(true)
    expect(isCi({ BUILDKITE: 'true' })).toBe(true)
  })
})
