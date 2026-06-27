/// Super WIP
/// Usage: test.mts <cwd> <targetFile>

import type { SetupConfig } from '@alint-js/cli'

import type { AgentAdapter } from './src/agent/types'

import process from 'node:process'

import { definePlugin, runAlint } from '@alint-js/cli'

import { createApeiraAdapter } from './src/agent/apeira'
import { createReinventedHelperRule } from './src/rules/reinvented-helper'

function withDebug(base: AgentAdapter): AgentAdapter {
  return async (request) => {
    const tools = request.tools.map(tool => ({
      ...tool,
      execute: async (input: unknown) => {
        console.error(`[tool] ${tool.name}(${JSON.stringify(input)})`)

        return tool.execute(input)
      },
    }))

    const result = await base({ ...request, tools })
    console.error(`[adapter] raw usage from apeira: ${JSON.stringify(result.usage)}`)

    return result
  }
}

const cwd = process.argv[2]
const target = process.argv[3] ?? 'target.ts'

const setupConfig: SetupConfig = {
  providers: [
    {
      endpoint: 'http://127.0.0.1:1234/v1',
      id: 'lmstudio',
      models: [{ id: 'zai-org/glm-4.6v-flash' }],
      type: 'openai-compatible',
    },
  ],
  version: 1,
}

const plugin = definePlugin({
  rules: { 'reinvented-helper': createReinventedHelperRule(withDebug(createApeiraAdapter())) },
  scope: '@alint-js/plugin-example',
})

console.error(`[live] running reinvented-helper on ${cwd}/${target} ...`)

try {
  const result = await runAlint({
    config: {
      plugins: [plugin],
      rules: { '@alint-js/plugin-example/reinvented-helper': 'warn' },
    },
    cwd,
    files: [target],
    setupConfig,
  })

  console.log('=== diagnostics ===')
  console.log(JSON.stringify(result.diagnostics, null, 2))
  console.log('=== usage ===')
  console.log(JSON.stringify(result.usage, null, 2))
}
catch (error) {
  console.error('[live] runAlint threw:', error instanceof Error ? error.message : error)

  if (error && typeof error === 'object' && 'result' in error) {
    console.log('=== partial result ===')
    console.log(JSON.stringify((error as { result: unknown }).result, null, 2))
  }
}
