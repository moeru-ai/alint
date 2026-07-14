import type { ResolvedModel } from '@alint-js/core'
import type { AgentAdapter, AgentRequest, AgentResult, AgentTool } from '@alint-js/core/agent'
import type { AgentTool as PiTool, StreamFn } from '@earendil-works/pi-agent-core'
import type { Model } from '@earendil-works/pi-ai'

import { defaultInferenceRetryPolicy } from '@alint-js/core/inference'
import { Agent } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/compat'

export interface PiAdapterOptions {
  maxRetries?: number
  run: (request: AgentRequest, maxRetries: number) => Promise<PiMessage[]>
}

interface PiMessage {
  content?: unknown
  role?: unknown
}

// NOTE(Makito): Extend this when necessary.
export function apiKeyFromModel(model: ResolvedModel): string {
  const auth = model.provider.headers.Authorization ?? model.provider.headers.authorization
  // Extract the key from header or fallback to a placeholder (no auth).
  return auth?.replace(/^Bearer\s+/i, '') ?? 'unused'
}

export function createPiAdapter(options: Partial<PiAdapterOptions> = {}): AgentAdapter {
  const maxRetries = options.maxRetries ?? defaultInferenceRetryPolicy.maxRetries
  const run = options.run ?? runPiAgent

  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new TypeError('Pi adapter maxRetries must be a non-negative integer')
  }

  return async (request: AgentRequest): Promise<AgentResult> => {
    const messages = await run(request, maxRetries)
    const assistant = [...messages].reverse().find(message => message.role === 'assistant')

    return { answer: extractPiText(assistant), usage: undefined }
  }
}

export function createPiModel(model: ResolvedModel): Model<'openai-completions'> {
  return {
    api: 'openai-completions',
    baseUrl: model.provider.endpoint,
    contextWindow: model.contextWindow ?? 32768,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id: model.id,
    input: ['text'],
    maxTokens: 4096,
    name: model.name,
    provider: model.provider.id as Model<'openai-completions'>['provider'],
    reasoning: false,
  }
}

export function extractPiText(message?: PiMessage): string {
  if (!message) {
    return ''
  }

  const { content } = message

  if (typeof content === 'string') {
    return content
  }

  if (Array.isArray(content)) {
    return content
      .filter((part): part is { text: string } => isTextPart(part))
      .map(part => part.text)
      .join('')
  }

  return ''
}

export function toPiTools(tools: AgentTool[]): PiTool[] {
  return tools.map((agentTool): PiTool => ({
    description: agentTool.description,
    execute: async (_toolCallId: string, params: unknown) => ({
      content: [{ text: String(await agentTool.execute(params)), type: 'text' }],
      details: undefined,
    }),
    label: agentTool.name,
    name: agentTool.name,
    parameters: Type.Unsafe(agentTool.parameters),
  } as PiTool))
}

function isTextPart(part: unknown): part is { text: string, type: 'text' } {
  return typeof part === 'object'
    && part !== null
    && (part as { type?: unknown }).type === 'text'
    && typeof (part as { text?: unknown }).text === 'string'
}

async function runPiAgent(request: AgentRequest, maxRetries: number): Promise<PiMessage[]> {
  request.signal?.throwIfAborted()
  const prompt = request.prompt

  const streamFn: StreamFn = (model, context, options) => streamSimple(model, context, {
    ...options,
    maxRetries,
  })
  const agent = new Agent({
    getApiKey: () => apiKeyFromModel(request.model),
    initialState: {
      model: createPiModel(request.model),
      systemPrompt: request.instructions,
      tools: toPiTools(request.tools),
    },
    streamFn,
  })
  const abort = () => agent.abort()

  request.signal?.addEventListener('abort', abort, { once: true })

  try {
    request.signal?.throwIfAborted()
    await agent.prompt(prompt)
    await agent.waitForIdle()
    request.signal?.throwIfAborted()
    return agent.state.messages as PiMessage[]
  }
  finally {
    request.signal?.removeEventListener('abort', abort)
  }
}
