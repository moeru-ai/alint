/// Super WIP

import type { ResolvedModel } from '@alint-js/core'
import type { AgentAdapter, AgentRequest, AgentResult, AgentTool, AgentUsage } from '@alint-js/core/agent'
import type { InferenceRetryPolicy } from '@alint-js/core/inference'
import type { AgentChannel, AgentInput, Runner, RunnerContext, Tool, Usage } from 'apeira'

import { createRetryingFetch } from '@alint-js/core/inference'
import { chat, rawTool, stepCountAtLeast, user } from 'apeira'

const defaultMaxSteps = 8

export interface ApeiraAdapterOptions {
  createRunner: (model: ResolvedModel, maxSteps: number, fetch: typeof globalThis.fetch) => Runner
  fetch: typeof globalThis.fetch
  maxSteps: number
  retryPolicy: Partial<InferenceRetryPolicy>
}

export function createApeiraAdapter(options: Partial<ApeiraAdapterOptions> = {}): AgentAdapter {
  const createRunner = options.createRunner ?? createApeiraRunner
  const maxSteps = options.maxSteps ?? defaultMaxSteps
  const fetch = createRetryingFetch({ fetch: options.fetch, policy: options.retryPolicy })

  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    throw new TypeError('Apeira adapter maxSteps must be a positive integer')
  }

  return async (request: AgentRequest): Promise<AgentResult> => {
    const runner = createRunner(request.model, maxSteps, fetch)
    const result = await runner(buildRunnerContext(request))

    return {
      answer: extractAnswer(result.output),
      usage: mapUsage(result.usage),
    }
  }
}

export function createApeiraRunner(
  model: ResolvedModel,
  maxSteps = defaultMaxSteps,
  fetch = createRetryingFetch(),
): Runner {
  // TODO(inference-stream-resume): retry after partial HTTP-200 output is deferred
  // until Apeira/xsAI exposes request-step resume; replaying the runner can repeat tools.
  return chat({
    baseURL: model.provider.endpoint,
    fetch,
    headers: model.provider.headers,
    model: model.id,
    stopWhen: stepCountAtLeast(maxSteps),
    streamOptions: { includeUsage: true },
  })
}

export function toRunnerTools(tools: AgentTool[]): Tool[] {
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

function buildRunnerContext(request: AgentRequest): RunnerContext {
  return {
    abortSignal: request.signal,
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
