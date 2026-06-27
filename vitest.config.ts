import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      'packages/core',
      'packages/config',
      'packages/cli',
      'packages/plugin-example',
    ],
  },
})
