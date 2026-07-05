import { definePlugin } from '@alint-js/core'

import { reinventedHelperRule } from './rules/reinvented-helper'

export {
  buildReinventedHelperPrompt,
  createReadFileTool,
  createReinventedHelperTools,
  createReportFindingTool,
  reinventedHelperInstructions,
  reinventedHelperRule,
} from './rules/reinvented-helper'
export type { ReinventedHelperFinding } from './rules/reinvented-helper'

export function createAgentExamplePlugin() {
  return definePlugin({
    configs: {
      recommended: [
        {
          files: ['**/*.ts'],
          language: 'text/plain',
          rules: {
            'agent-example/reinvented-helper': 'warn',
          },
        },
      ],
    },
    rules: {
      'reinvented-helper': reinventedHelperRule,
    },
  })
}

export const agentExamplePlugin = createAgentExamplePlugin()

export default agentExamplePlugin
