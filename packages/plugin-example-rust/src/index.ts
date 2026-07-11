import type { AgentTool } from '@alint-js/core/agent'

import { definePlugin } from '@alint-js/core'
import { createTools as createFsTools, DEFAULT_IGNORE_PATTERNS } from '@alint-js/tools-fs'

export function createRustPlugin() {
  return definePlugin({
    configs: {
      example: [
        {
          files: ['**/*.rs'],
          language: 'text/plain',
          rules: {},
        },
      ],
    },
    rules: {},
  })
}

export function createTools(cwd: string): AgentTool[] {
  return createFsTools(cwd, { ignore: [...DEFAULT_IGNORE_PATTERNS, '**/target/**'] })
}

export const rustPlugin = createRustPlugin()

export default rustPlugin
