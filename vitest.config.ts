import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      'packages/core',
      'packages/config',
      'packages/cli',
      'packages/tools-fs',
      'packages/plugin-example',
      'packages/plugin-example-agent',
      'packages/plugin-example-go',
      'packages/plugin-example-rust',
      'packages/plugin-example-python',
      'packages/agent-apeira',
      'packages/agent-pi',
    ],
  },
})
