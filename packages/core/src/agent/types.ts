import type { ResolvedModel } from '../models/types'

export type AgentAdapter = (request: AgentRequest) => Promise<AgentResult>

export interface AgentRequest {
  instructions: string
  model: ResolvedModel
  prompt: string
  signal?: AbortSignal
  tools: AgentTool[]
}

export interface AgentResult {
  answer: string
  usage?: AgentUsage
}

/** Agent-agnostic tool definition. Each adapter translates it to its framework's tool format. */
export interface AgentTool {
  description: string
  execute: (input: unknown) => Promise<unknown> | unknown
  name: string
  parameters: Record<string, unknown>
}

export interface AgentUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}
