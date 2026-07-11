import { describe, expect, it } from 'vitest'

import { createRustPlugin, rustPlugin } from './index'

describe('rustPlugin', () => {
  it('creates an empty Rust plugin scaffold with Rust file matching', () => {
    const plugin = createRustPlugin()

    expect(plugin.rules).toEqual({})
    expect(plugin.configs?.example).toEqual(rustPlugin.configs?.example)
    expect(rustPlugin.configs?.example).toEqual([
      {
        files: ['**/*.rs'],
        language: 'text/plain',
        rules: {},
      },
    ])
  })
})
