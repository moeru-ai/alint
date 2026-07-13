import { ignorePatternsAIAgents, ignorePatternsCommon } from '@alint-js/config'
import { defineConfig } from '@alint-js/core'
import { examplePlugin } from '@alint-js/plugin-example'

export default defineConfig([
  {
    ignores: [
      ...ignorePatternsCommon,
      ...ignorePatternsAIAgents,

      // Ignore internal fixtures
      'packages/plugin-simplicity/fixtures/**',
    ],
  },
  {
    ignore: {
      gitignore: true,
    },
  },
  {
    files: ['**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}'],
    plugins: {
      example: examplePlugin,
    },
  },
])
