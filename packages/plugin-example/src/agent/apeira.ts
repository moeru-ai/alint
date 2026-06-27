/// Super WIP

import type { ResolvedModel } from '@alint-js/cli'
import type { AgentChannel, AgentInput, Runner, RunnerContext, Tool, Usage } from 'apeira'

import type { AgentAdapter, AgentRequest, AgentResult, AgentTool, AgentUsage } from './types'

import { chat, stepCountAtLeast, user } from 'apeira'
import { rawTool } from 'xsai'

const maxSteps = 8

export interface ApeiraAdapterOptions {
  createRunner: (model: ResolvedModel) => Runner
}

export function createApeiraAdapter(options: Partial<ApeiraAdapterOptions> = {}): AgentAdapter {
  const createRunner = options.createRunner ?? createApeiraRunner

  return async (request: AgentRequest): Promise<AgentResult> => {
    const runner = createRunner(request.model)
    const result = await runner(buildRunnerContext(request))

    return {
      answer: extractAnswer(result.output),
      usage: mapUsage(result.usage),
    }
  }
}

export function createApeiraRunner(model: ResolvedModel): Runner {
  return chat({
    baseURL: model.provider.endpoint,
    headers: model.provider.headers,
    model: model.id,
    stopWhen: stepCountAtLeast(maxSteps),
  })
}

function buildRunnerContext(request: AgentRequest): RunnerContext {
  return {
    channel: noopChannel(),
    input: [user(request.prompt)],
    instructions: request.instructions,
    tools: toRunnerTools(request.tools),
    turnId: 'alint',
  }
}

function extractAnswer(output: readonly AgentInput[]): string {
  for (let index = output.length - 1; index >= 0; index -= 1) {
    const item = output[index] as { content?: unknown, role?: unknown }

    if (item.role === 'assistant' && typeof item.content === 'string') {
      return item.content
    }
  }

  return ''
}

function mapUsage(usage?: Usage): AgentUsage | undefined {
  if (!usage) {
    return undefined
  }

  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
  }
}

function noopChannel(): AgentChannel {
  return {
    emit: () => {},
    subscribe: () => () => {},
  }
}

function toRunnerTools(tools: AgentTool[]): Tool[] {
  return tools.map(agentTool => rawTool({
    description: agentTool.description,
    execute: async (input) => {
      const result = await agentTool.execute(input)
      return (result ?? '') as object | string | unknown[]
    },
    name: agentTool.name,
    parameters: agentTool.parameters,
  }))
}
