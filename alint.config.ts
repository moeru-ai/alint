import jsPlugin from '@alint-js/plugin-js'

import { defineConfig } from '@alint-js/cli'
import { ignorePatternsAIAgents, ignorePatternsCommon } from '@alint-js/config'

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
    extends: ['example/recommended'],
    files: ['**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}'],
    plugins: {
      js: jsPlugin,
    },
  },
])
