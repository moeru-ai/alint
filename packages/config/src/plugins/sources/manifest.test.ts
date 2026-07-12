import { expect, it } from 'vitest'

import { resolveRelativeRootEntry } from './manifest'

it('selects the Node ESM root export instead of require or browser conditions', () => {
  expect(resolveRelativeRootEntry({
    exports: {
      '.': {
        browser: './dist/browser.mjs',
        import: './dist/import.mjs',
        require: './dist/require.cjs',
        // eslint-disable-next-line perfectionist/sort-objects -- Conditional exports are selected in key order; default must remain last.
        default: './dist/default.mjs',
      },
    },
    name: 'conditional-plugin',
  })).toBe('dist/import.mjs')
})
