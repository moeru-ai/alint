import type { RuleContext } from '@alint-js/core'
import type { JsonSchema } from '@valibot/to-json-schema'
import type { InferOutput } from 'valibot'
import type { GenerateTextResult } from 'xsai'

import { defineRule } from '@alint-js/core'
import { errorMessageFrom } from '@moeru/std/error'
import { sleep } from '@moeru/std/sleep'
import { toJsonSchema } from '@valibot/to-json-schema'
import { array, description, getDescription, number, object, optional, parse, picklist, pipe, string } from 'valibot'
import { generateText, rawTool } from 'xsai'

import { collectResponsibilityBoundaryContext } from './context'
import { responsibilityBoundaryPrompt } from './prompt'

const reportFindingsToolName = 'reportFindings'
const maxJudgeAttempts = 3

export const responsibilityBoundaryFindingSchema = pipe(
  object({
    category: pipe(
      picklist(['responsibility-boundary', 'constructor-cohesion', 'domain-placement', 'testability']),
      description('Finding category. Use exactly one of responsibility-boundary, constructor-cohesion, domain-placement, or testability.'),
    ),
    confidence: pipe(
      picklist(['high', 'medium', 'low']),
      description('Confidence in this finding. Use exactly "low", "medium", or "high" without punctuation.'),
    ),
    line: pipe(
      number(),
      description([
        'Use the left-column line number from the numbered code block.',
        'Pick the first line of the function, type, import group, or declaration that best represents the finding.',
        'Do not point at a caller only because it mentions another helper; choose the declaration that owns the misplaced responsibility.',
      ].join(' ')),
    ),
    message: pipe(
      string(),
      description([
        'Describe the architectural problem in this Go file.',
        'Mention the concrete responsibility being mixed or split.',
        'Do not require an exact function name match.',
        'Keep the message short.',
      ].join(' ')),
    ),
    relatedDeclarations: optional(pipe(
      array(object({
        line: pipe(
          number(),
          description('Left-column line number for another declaration that participates in the same cohesive issue cluster.'),
        ),
        name: pipe(
          string(),
          description('Declaration name or short declaration label from the reviewed source.'),
        ),
        role: pipe(
          string(),
          description('Brief role this declaration plays in the same issue cluster, such as result type, script data, wrapper, helper, or owner operation.'),
        ),
      })),
      description('Related declarations that are evidence for the same cohesive issue cluster. Omit when the finding is intentionally per-declaration.'),
    )),
    suggestion: pipe(
      string(),
      description([
        'Give one concrete design direction.',
        'Prefer focused Go files, cohesive owners, or moving domain policy near its owning package when they fit.',
        'Do not provide a code patch.',
        'Keep the suggestion under 45 words.',
      ].join(' ')),
    ),
  }),
  description('One warning-level report for a Go responsibility boundary or constructor cohesion design smell.'),
)

export const responsibilityBoundaryResponseSchema = pipe(
  object({
    findings: pipe(
      array(responsibilityBoundaryFindingSchema),
      description('All warning-level Go responsibility boundary findings. Return an empty array when the file is already focused and cohesive.'),
    ),
  }),
  description('Report Go responsibility-boundary findings for this file.'),
)

interface NormalizedUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

type ResponsibilityBoundaryFinding = InferOutput<typeof responsibilityBoundaryFindingSchema>

class InvalidJudgeResponseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidJudgeResponseError'
  }
}

const reportFindingsTool = rawTool({
  description: getDescription(responsibilityBoundaryResponseSchema),
  execute: input => asRecord(input) ?? {},
  name: reportFindingsToolName,
  parameters: createReportFindingsToolParameters(),
  strict: true,
})

export const responsibilityBoundaryRule = defineRule({
  create: ctx => ({
    async onTarget(target) {
      if (target.kind !== 'file' || !target.file.path.endsWith('.go')) {
        return
      }

      const findings = await judgeResponsibilityBoundary(ctx, target.file)

      reportResponsibilityBoundaryFindings(ctx, target.file.path, findings)
    },
  }),
})

export function createReportFindingsToolParameters(): JsonSchema {
  return normalizeToolJsonSchema(toJsonSchema(responsibilityBoundaryResponseSchema))
}

export function createResponsibilityBoundaryMessages(
  source: string,
  previousError: string | undefined,
  outputLanguage?: string,
  context?: string,
) {
  return [
    {
      content: responsibilityBoundaryPrompt,
      role: 'system' as const,
    },
    ...(previousError
      ? [
          {
            content: [
              'Your previous tool call could not be validated.',
              `Validation error: ${previousError}`,
              `Call ${reportFindingsToolName} again with arguments that exactly match the tool schema.`,
            ].join('\n'),
            role: 'user' as const,
          },
        ]
      : []),
    {
      content: [
        formatOutputLanguageInstruction(outputLanguage),
        context ? `Supplemental project context:\n\n${context}` : undefined,
        `Go code with line numbers:\n\n${formatSourceWithLineNumbers(source)}`,
      ].filter(Boolean).join('\n\n'),
      role: 'user' as const,
    },
  ]
}

export { collectResponsibilityBoundaryContext, responsibilityBoundaryPrompt }

export function reportResponsibilityBoundaryFindings(
  ctx: RuleContext,
  filePath: string,
  findings: readonly ResponsibilityBoundaryFinding[],
): void {
  for (const finding of findings) {
    const evidence = {
      category: finding.category,
      confidence: finding.confidence,
      ...(finding.relatedDeclarations ? { relatedDeclarations: finding.relatedDeclarations } : {}),
      suggestion: finding.suggestion,
    }

    ctx.report({
      evidence,
      filePath,
      loc: {
        start: {
          column: 0,
          line: finding.line,
        },
      },
      message: finding.message,
    })
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function formatOutputLanguageInstruction(outputLanguage: string | undefined): string | undefined {
  return outputLanguage
    ? `Write all human-readable finding messages and suggestions in this language: ${outputLanguage}.`
    : undefined
}

function formatSourceWithLineNumbers(source: string): string {
  return source
    .split('\n')
    .map((line, index) => `${index + 1} | ${line}`)
    .join('\n')
}

function isRetriableJudgeCallError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return true
  }

  return error.name === 'InvalidToolCallError'
    || error.name === 'InvalidToolInputError'
    || error.name === 'ToolExecutionError'
}

async function judgeResponsibilityBoundary(
  ctx: RuleContext,
  file: { path: string, text: string },
): Promise<ResponsibilityBoundaryFinding[]> {
  const model = await ctx.model()
  let previousError: string | undefined
  const context = await collectResponsibilityBoundaryContext(ctx, file.path, file.text, model)

  for (let attempt = 1; attempt <= maxJudgeAttempts; attempt += 1) {
    let response: GenerateTextResult

    try {
      response = await generateText({
        baseURL: model.provider.endpoint,
        headers: model.provider.headers,
        messages: createResponsibilityBoundaryMessages(file.text, previousError, ctx.outputLanguage, context),
        model: model.id,
        parallelToolCalls: false,
        temperature: 0,
        toolChoice: {
          function: {
            name: reportFindingsToolName,
          },
          type: 'function',
        },
        tools: [reportFindingsTool],
      })
    }
    catch (error) {
      previousError = `Tool call failed before validation: ${errorMessageFrom(error) ?? String(error)}`
      ctx.logger.debug(`Go responsibility-boundary judge attempt ${attempt} failed while calling the model: ${previousError}`)

      if (!isRetriableJudgeCallError(error) || attempt === maxJudgeAttempts) {
        throw error
      }

      await waitBeforeRetry(attempt)
      continue
    }

    recordJudgeUsage(ctx, model, response)

    const result = parseFindingsFromJudgeResponse(response)

    if (result.ok) {
      return result.findings
    }

    previousError = result.error
    ctx.logger.debug(`Go responsibility-boundary judge attempt ${attempt} returned an invalid structured result: ${previousError}`)

    if (!result.retriable || attempt === maxJudgeAttempts) {
      throw new InvalidJudgeResponseError(`Invalid LLM judge response: ${previousError}`)
    }

    await waitBeforeRetry(attempt)
  }

  throw new InvalidJudgeResponseError('Judge did not return a valid structured result')
}

function normalizeJsonSchemaDefinition(schema: boolean | JsonSchema): boolean | JsonSchema {
  if (typeof schema === 'boolean') {
    return schema
  }

  const normalized: JsonSchema = { ...schema }

  delete normalized.$schema

  if (normalized.type === 'object') {
    normalized.additionalProperties = false
  }

  if (normalized.properties) {
    normalized.properties = Object.fromEntries(
      Object.entries(normalized.properties).map(([key, propertySchema]) => [
        key,
        normalizeJsonSchemaDefinition(propertySchema),
      ]),
    )
  }

  if (normalized.items) {
    normalized.items = Array.isArray(normalized.items)
      ? normalized.items.map(item => normalizeJsonSchemaDefinition(item))
      : normalizeJsonSchemaDefinition(normalized.items)
  }

  if (normalized.$defs) {
    normalized.$defs = normalizeJsonSchemaMap(normalized.$defs)
  }

  if (normalized.definitions) {
    normalized.definitions = normalizeJsonSchemaMap(normalized.definitions)
  }

  for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
    if (normalized[key]) {
      normalized[key] = normalized[key].map(item => normalizeJsonSchemaDefinition(item))
    }
  }

  if (normalized.not) {
    normalized.not = normalizeJsonSchemaDefinition(normalized.not)
  }

  return normalized
}

function normalizeJsonSchemaMap(map: Record<string, boolean | JsonSchema>): Record<string, boolean | JsonSchema> {
  return Object.fromEntries(
    Object.entries(map).map(([key, schema]) => [
      key,
      normalizeJsonSchemaDefinition(schema),
    ]),
  )
}

function normalizeToolJsonSchema(schema: JsonSchema): JsonSchema {
  const normalized = normalizeJsonSchemaDefinition(schema)

  return typeof normalized === 'boolean' ? {} : normalized
}

function normalizeUsage(usage: unknown): NormalizedUsage | undefined {
  const record = asRecord(usage)

  if (!record) {
    return undefined
  }

  const normalized = {
    inputTokens: numberFromRecord(record, 'inputTokens') ?? numberFromRecord(record, 'input_tokens') ?? numberFromRecord(record, 'prompt_tokens'),
    outputTokens: numberFromRecord(record, 'outputTokens') ?? numberFromRecord(record, 'output_tokens') ?? numberFromRecord(record, 'completion_tokens'),
    totalTokens: numberFromRecord(record, 'totalTokens') ?? numberFromRecord(record, 'total_tokens'),
  }

  return Object.values(normalized).some(value => value !== undefined)
    ? normalized
    : undefined
}

function numberFromRecord(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseFindingsFromJudgeResponse(response: GenerateTextResult):
  | { error: string, ok: false, retriable: boolean }
  | { findings: ResponsibilityBoundaryFinding[], ok: true } {
  if (response.finishReason === 'content_filter') {
    return {
      error: `${reportFindingsToolName} was not returned because the model finished with content_filter`,
      ok: false,
      retriable: false,
    }
  }

  if (response.finishReason === 'length') {
    return {
      error: `${reportFindingsToolName} was not returned completely because the model finished with length`,
      ok: false,
      retriable: true,
    }
  }

  const toolResults = response.toolResults.filter(result => result.toolName === reportFindingsToolName)

  if (toolResults.length === 0) {
    return {
      error: `Missing ${reportFindingsToolName} tool result; finishReason=${response.finishReason}`,
      ok: false,
      retriable: true,
    }
  }

  if (toolResults.length > 1) {
    return {
      error: `Expected one ${reportFindingsToolName} tool result, received ${toolResults.length}`,
      ok: false,
      retriable: true,
    }
  }

  try {
    return {
      findings: parse(responsibilityBoundaryResponseSchema, toolResults[0].result).findings,
      ok: true,
    }
  }
  catch (error) {
    return {
      error: errorMessageFrom(error) ?? String(error),
      ok: false,
      retriable: true,
    }
  }
}

function recordJudgeUsage(ctx: RuleContext, model: Awaited<ReturnType<RuleContext['model']>>, response: GenerateTextResult) {
  const usage = normalizeUsage(response.usage)

  if (!usage) {
    return
  }

  ctx.metering.recordUsage({
    inputTokens: usage.inputTokens,
    metadata: {
      operation: 'go-responsibility-boundary-judge',
    },
    modelId: model.id,
    outputTokens: usage.outputTokens,
    providerId: model.provider.id,
    totalTokens: usage.totalTokens,
  })
}

function waitBeforeRetry(attempt: number): Promise<void> {
  return sleep(500 * 2 ** (attempt - 1))
}
