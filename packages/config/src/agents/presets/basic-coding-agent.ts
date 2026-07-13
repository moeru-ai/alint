import type { ResolvedModel, RuleContext, RuleDefinition } from '@alint-js/core'
import type { AgentTool, AgentUsage } from '@alint-js/core/agent'
import type { AgentChannel, AgentInput, Runner, RunnerContext, Tool, Usage } from 'apeira'

import type { DeclarativeFindingResponse, DeclarativeRuleDefinition } from '../../plugins/declarative/types'

import { formatOutputLanguageInstruction, formatSourceWithLineNumbers } from '@alint-js/core/structured-output'
import { createTools } from '@alint-js/tools-fs'
import { errorMessageFrom } from '@moeru/std/error'
import { rawTool } from '@xsai/tool'
import { chat, stepCountAtLeast, user } from 'apeira'
import { parse } from 'valibot'

import { declarativeFindingResponseSchema } from '../../plugins/declarative/types'
import { reportDeclarativeFindings } from './basic-structured'

const maxAgentSteps = 8
const maxAnswerPreviewLength = 200

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

export class InvalidCodingAgentOutputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidCodingAgentOutputError'
  }
}

export function buildCodingAgentRequest(options: BuildCodingAgentRequestOptions): CodingAgentRequest {
  return {
    instructions: [
      options.instruction,
      'Return only JSON matching this shape: {"findings":[{"filePath":"optional/path","line":1,"message":"finding message","suggestion":"optional suggestion","confidence":"high|medium|low"}]}.',
      'Do not wrap the JSON in Markdown fences, prose, or comments. Return {"findings":[]} when there are no issues.',
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

        const { findings } = parseCodingAgentAnswer(result.answer)

        reportDeclarativeFindings({
          ctx,
          excludeFiles: _rule.excludeFiles,
          findings,
          includeFiles: _rule.includeFiles,
          targetFilePath: target.file.path,
        })
      },
    }),
  }
}

export function extractAnswer(output: readonly AgentInput[]): string {
  for (let index = output.length - 1; index >= 0; index -= 1) {
    const item = output[index] as { content?: unknown, role?: unknown }

    if (item.role === 'assistant' && typeof item.content === 'string') {
      return item.content
    }
  }

  return ''
}

export function parseCodingAgentAnswer(answer: string): DeclarativeFindingResponse {
  try {
    return parse(declarativeFindingResponseSchema, JSON.parse(answer))
  }
  catch (error) {
    throw new InvalidCodingAgentOutputError(
      `Invalid basic-coding-agent JSON response: ${errorMessageFrom(error) ?? String(error)}. Answer preview: ${previewAnswer(answer)}`,
    )
  }
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

function buildRunnerContext(request: CodingAgentRequest): RunnerContext {
  return {
    channel: noopChannel(),
    input: [user(request.prompt)],
    instructions: request.instructions,
    tools: toRunnerTools(request.tools),
    turnId: 'alint',
  }
}

function createCodingAgentRunner(model: ResolvedModel): Runner {
  return chat({
    baseURL: model.provider.endpoint,
    headers: model.provider.headers,
    model: model.id,
    stopWhen: stepCountAtLeast(maxAgentSteps),
  })
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

function previewAnswer(answer: string): string {
  return answer.length > maxAnswerPreviewLength
    ? answer.slice(0, maxAnswerPreviewLength)
    : answer
}

async function runCodingAgent(request: CodingAgentRequest & { model: ResolvedModel }): Promise<{
  answer: string
  usage?: AgentUsage
}> {
  const runner = createCodingAgentRunner(request.model)
  const result = await runner(buildRunnerContext(request))

  return {
    answer: extractAnswer(result.output),
    usage: mapUsage(result.usage),
  }
}
