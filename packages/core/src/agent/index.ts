import type { RuleContext } from '../dsl/types'
import type { AgentAdapter, AgentRequest, AgentResult, AgentTool, AgentUsage } from './types'

export type { AgentAdapter, AgentRequest, AgentResult, AgentTool, AgentUsage }

export function defineTool(tool: AgentTool): AgentTool {
  return tool
}

export function requireAgent(context: Pick<RuleContext, 'agent' | 'id' | 'signal'>): AgentAdapter {
  if (!context.agent) {
    throw new TypeError(
      `Rule "${context.id}" requires an agent, but none is configured. Set "agent" in alint config (e.g. agent: createApeiraAdapter()).`,
    )
  }

  const agent = context.agent

  // Inject the run's cancellation signal so rules get cancellation without opting in. A rule
  // that passes its own signal keeps it, which is how a rule narrows cancellation to one call.
  return async request => agent({
    ...request,
    signal: request.signal ?? context.signal,
  })
}
