/// Super WIP
/// Usage: test.mts <cwd> <targetFile> <apeira|pi>

import type { AgentAdapter } from '@alint-js/agent'
import type { SetupConfig } from '@alint-js/core'

import process from 'node:process'

import { createApeiraAdapter } from '@alint-js/agent-apeira'
import { definePlugin, runAlint } from '@alint-js/core'
import { errorMessageFrom } from '@moeru/std/error'

import { createPiAdapter } from './src/agent/pi'
import { createReinventedHelperRule } from './src/rules/reinvented-helper'

const cwd = process.argv[2]
const target = process.argv[3] ?? 'target.ts'
const which = process.argv[4] ?? 'apeira'

const base = which === 'pi' ? createPiAdapter() : createApeiraAdapter()

function withDebug(adapter: AgentAdapter): AgentAdapter {
  return async (request) => {
    const tools = request.tools.map(tool => ({
      ...tool,
      execute: async (input: unknown) => {
        console.error(`[tool] ${tool.name}(${JSON.stringify(input)})`)

        return tool.execute(input)
      },
    }))

    const result = await adapter({ ...request, tools })
    console.error(`[adapter:${which}] raw usage: ${JSON.stringify(result.usage)}`)

    return result
  }
}

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
  rules: { 'reinvented-helper': createReinventedHelperRule(withDebug(base)) },
  scope: '@alint-js/plugin-example',
})

async function main() {
  console.error(`[test] running reinvented-helper via ${which} on ${cwd}/${target} ...`)

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

    console.info('=== diagnostics ===')
    console.info(JSON.stringify(result.diagnostics, null, 2))
  }
  catch (error) {
    console.error('[test] runAlint threw:', errorMessageFrom(error) ?? String(error))

    if (error && typeof error === 'object' && 'result' in error) {
      console.info('=== partial result ===')
      console.info(JSON.stringify((error as { result: unknown }).result, null, 2))
    }
  }
}

void main()
