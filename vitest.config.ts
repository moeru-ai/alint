import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      'packages/core',
      'packages/config',
      'packages/cli',
      'packages/agent',
      'packages/agent-apeira',
      'packages/plugin-example',
    ],
  },
})
