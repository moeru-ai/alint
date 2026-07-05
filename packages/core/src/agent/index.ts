import type { RuleContext } from '../dsl/types'
import type { AgentAdapter, AgentRequest, AgentResult, AgentTool, AgentUsage } from './types'

export type { AgentAdapter, AgentRequest, AgentResult, AgentTool, AgentUsage }

export function defineTool(tool: AgentTool): AgentTool {
  return tool
}

export function requireAgent(context: Pick<RuleContext, 'agent' | 'id'>): AgentAdapter {
  if (!context.agent) {
    throw new TypeError(
      `Rule "${context.id}" requires an agent, but none is configured. Set "agent" in alint config (e.g. agent: createApeiraAdapter()).`,
    )
  }

  return context.agent
}
