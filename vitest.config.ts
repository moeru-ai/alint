import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      'packages/core',
      'packages/config',
      'packages/cli',
      'packages/plugin-example',
      'packages/plugin-example-agent',
      'packages/plugin-example-go',
      'packages/plugin-example-rust',
      'packages/agent-apeira',
      'packages/agent-pi',
    ],
  },
})
