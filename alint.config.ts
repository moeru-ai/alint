import { defineConfig } from '@alint-js/core'
import { examplePlugin } from '@alint-js/plugin-example'

export default defineConfig([
  {
    files: ['**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}'],
    plugins: {
      example: examplePlugin,
    },
    rules: {
      'example/inline-miniature-normalizer': 'warn',
    },
  },
])
