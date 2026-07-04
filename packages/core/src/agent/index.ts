import type { AgentAdapter, AgentRequest, AgentResult, AgentTool, AgentUsage } from './types'

export type { AgentAdapter, AgentRequest, AgentResult, AgentTool, AgentUsage }

export function defineTool(tool: AgentTool): AgentTool {
  return tool
}
