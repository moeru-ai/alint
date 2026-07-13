import type { ResolvedModel, RuleContext, RuleDefinition } from '@alint-js/core'
import type { AgentTool, AgentUsage } from '@alint-js/core/agent'
import type { AgentChannel, ChatRunnerOptions, Runner, RunnerContext, Tool, Usage } from 'apeira'

import type { DeclarativeFindingResponse, DeclarativeRuleDefinition } from '../../plugins/declarative/types'

import { formatOutputLanguageInstruction, formatSourceWithLineNumbers, toolParametersFromSchema } from '@alint-js/core/structured-output'
import { createTools } from '@alint-js/tools-fs'
import { rawTool } from '@xsai/tool'
import { chat, hasToolCall, or, stepCountAtLeast, user } from 'apeira'
import { parse } from 'valibot'

import { declarativeFindingResponseSchema } from '../../plugins/declarative/types'
import { reportDeclarativeFindings } from './basic-structured'

const maxAgentSteps = 8
export const reportFindingsToolName = 'report_findings'

export interface BuildCodingAgentRequestOptions {
  cwd: string
  instruction: string
  outputLanguage?: string
  sourceText: string
  targetFilePath: string
  tools: AgentTool[]
}

export interface CodingAgentRequest {
  instructions: string
  prompt: string
  tools: AgentTool[]
}

export function buildCodingAgentRequest(options: BuildCodingAgentRequestOptions): CodingAgentRequest {
  return {
    instructions: [
      options.instruction,
      'Use the filesystem tools to inspect the project as needed before reaching a conclusion.',
      `When the review is complete, call ${reportFindingsToolName} exactly once with all findings. Submit an empty findings array when there are no issues.`,
    ].join('\n\n'),
    prompt: [
      formatOutputLanguageInstruction(options.outputLanguage),
      `Project root: ${options.cwd}`,
      `Reviewed target file path: ${options.targetFilePath}`,
      `Reviewed target source with line numbers:\n\n${formatSourceWithLineNumbers(options.sourceText)}`,
    ].filter(Boolean).join('\n\n'),
    tools: options.tools,
  }
}

export function createBasicCodingAgentRule(_rule: DeclarativeRuleDefinition): RuleDefinition {
  return {
    cache: false,
    create: ctx => ({
      async onTarget(target) {
        if (target.kind !== 'file') {
          return
        }

        const model = await ctx.model()
        const request = buildCodingAgentRequest({
          cwd: ctx.cwd,
          instruction: _rule.instruction,
          outputLanguage: ctx.outputLanguage,
          sourceText: target.file.text,
          targetFilePath: target.file.path,
          tools: createTools(ctx.cwd),
        })
        const result = await runCodingAgent({
          ...request,
          model,
        })

        recordCodingAgentUsage({
          ctx,
          filePath: target.file.path,
          model,
          rule: _rule,
          usage: result.usage,
        })

        reportDeclarativeFindings({
          ctx,
          excludeFiles: _rule.excludeFiles,
          findings: result.findings,
          includeFiles: _rule.includeFiles,
          targetFilePath: target.file.path,
        })
      },
    }),
  }
}

export function createCodingAgentRunnerOptions(model: ResolvedModel): ChatRunnerOptions {
  return {
    baseURL: model.provider.endpoint,
    headers: model.provider.headers,
    model: model.id,
    parallelToolCalls: false,
    stopWhen: or(hasToolCall(reportFindingsToolName), stepCountAtLeast(maxAgentSteps)),
    toolChoice: 'required',
  }
}

export function createReportFindingsTool(onReport: (report: DeclarativeFindingResponse) => void): Tool {
  return rawTool({
    description: 'Submit all findings and finish the review. Submit an empty findings array when there are no issues.',
    execute: async (input) => {
      const report = parse(declarativeFindingResponseSchema, input)
      onReport(report)
      return report
    },
    name: reportFindingsToolName,
    parameters: toolParametersFromSchema(declarativeFindingResponseSchema),
    strict: true,
  })
}

export function recordCodingAgentUsage(options: {
  ctx: Pick<RuleContext, 'id' | 'metering'>
  filePath: string
  model: ResolvedModel
  rule: DeclarativeRuleDefinition
  usage?: AgentUsage
}): void {
  if (!options.usage) {
    return
  }

  options.ctx.metering.recordUsage({
    filePath: options.filePath,
    inputTokens: options.usage.inputTokens,
    metadata: {
      operation: `declarative-${options.rule.name}-coding-agent`,
    },
    modelId: options.model.id,
    outputTokens: options.usage.outputTokens,
    providerId: options.model.provider.id,
    ruleId: options.ctx.id,
    totalTokens: options.usage.totalTokens,
  })
}

export async function runCodingAgent(
  request: CodingAgentRequest & { model: ResolvedModel },
  runner: Runner = createCodingAgentRunner(request.model),
): Promise<{
  findings: DeclarativeFindingResponse['findings']
  usage?: AgentUsage
}> {
  let report: DeclarativeFindingResponse | undefined
  const result = await runner(buildRunnerContext(request, value => report = value))

  if (!report) {
    throw new Error(`basic-coding-agent stopped without calling ${reportFindingsToolName}`)
  }

  return {
    findings: report.findings,
    usage: mapUsage(result.usage),
  }
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

function buildRunnerContext(
  request: CodingAgentRequest,
  onReport: (report: DeclarativeFindingResponse) => void,
): RunnerContext {
  return {
    channel: noopChannel(),
    input: [user(request.prompt)],
    instructions: request.instructions,
    tools: [...toRunnerTools(request.tools), createReportFindingsTool(onReport)],
    turnId: 'alint',
  }
}

function createCodingAgentRunner(model: ResolvedModel): Runner {
  return chat(createCodingAgentRunnerOptions(model))
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
