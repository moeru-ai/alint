import type { ResolvedModel, RuleContext } from '@alint-js/core'
import type { JsonSchema } from '@valibot/to-json-schema'
import type { InferOutput } from 'valibot'
import type { GenerateTextResult } from 'xsai'

import { toJsonSchema } from '@valibot/to-json-schema'
import { array, description, getDescription, number, object, parse, picklist, pipe, string } from 'valibot'
import { generateText, rawTool } from 'xsai'

const reportFindingsToolName = 'reportFindings'
const maxJudgeAttempts = 3

export const judgeFindingSchema = pipe(
  object({
    confidence: pipe(
      picklist(['high', 'medium', 'low']),
      description('Confidence in this finding. Use exactly "low", "medium", or "high" without punctuation.'),
    ),
    line: pipe(
      number(),
      description([
        'Use the declaration line of the specific symbol being reported.',
        'Use the left-column line number from the numbered code block.',
        'Do not use a nearby caller line unless that caller is the symbol being reported.',
      ].join(' ')),
    ),
    message: pipe(
      string(),
      description([
        'Mention the specific symbol being reported.',
        'Explain the rule-specific design or readability smell.',
        'Do not list unrelated symbol names in the message.',
        'Keep the message short.',
      ].join(' ')),
    ),
    suggestion: pipe(
      string(),
      description([
        'Provide one concrete remediation direction.',
        'Do not propose a code patch.',
        'Keep the suggestion under 35 words.',
      ].join(' ')),
    ),
  }),
  description('One warning-level report for a rule-specific design or readability smell.'),
)

export const judgeResponseSchema = pipe(
  object({
    findings: pipe(
      array(judgeFindingSchema),
      description('All warning-level findings. Return an empty array when there is no qualifying issue for the current rule.'),
    ),
  }),
  description('Report findings for this TypeScript file.'),
)

export type JudgeFinding = InferOutput<typeof judgeFindingSchema>

interface JudgeSourceOptions {
  logger: RuleContext['logger']
  metering: RuleContext['metering']
  model: ResolvedModel
  operation: string
  outputLanguage?: string
  prompt: string
  source: string
}

interface NormalizedUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

class InvalidJudgeResponseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidJudgeResponseError'
  }
}

const reportFindingsTool = rawTool({
  description: getDescription(judgeResponseSchema),
  execute: input => asRecord(input) ?? {},
  name: reportFindingsToolName,
  parameters: createReportFindingsToolParameters(),
  strict: true,
})

export function createJudgeMessages(
  source: string,
  previousError: string | undefined,
  outputLanguage: string | undefined,
  prompt: string,
) {
  return [
    {
      content: prompt,
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
        `Code with line numbers:\n\n${formatSourceWithLineNumbers(source)}`,
      ].filter(Boolean).join('\n\n'),
      role: 'user' as const,
    },
  ]
}

export function createReportFindingsToolParameters(): JsonSchema {
  return normalizeToolJsonSchema(toJsonSchema(judgeResponseSchema))
}

export async function judgeSource(
  options: JudgeSourceOptions,
): Promise<JudgeFinding[]> {
  let previousError: string | undefined

  for (let attempt = 1; attempt <= maxJudgeAttempts; attempt += 1) {
    let response: GenerateTextResult

    try {
      response = await generateText({
        baseURL: options.model.provider.endpoint,
        headers: options.model.provider.headers,
        messages: createJudgeMessages(options.source, previousError, options.outputLanguage, options.prompt),
        model: options.model.id,
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
      previousError = `Tool call failed before validation: ${stringifyUnknownError(error)}`
      options.logger.debug(`Judge attempt ${attempt} failed while calling the model: ${previousError}`)

      if (!isRetriableJudgeCallError(error) || attempt === maxJudgeAttempts) {
        throw error
      }

      await waitBeforeRetry(attempt)
      continue
    }

    recordJudgeUsage(options.metering, options.model, response, options.operation)

    const result = parseFindingsFromJudgeResponse(response)

    if (result.ok) {
      return result.findings
    }

    previousError = result.error
    options.logger.debug(`Judge attempt ${attempt} returned an invalid structured result: ${previousError}`)

    if (!result.retriable || attempt === maxJudgeAttempts) {
      throw new InvalidJudgeResponseError(`Invalid LLM judge response: ${previousError}`)
    }

    await waitBeforeRetry(attempt)
  }

  throw new InvalidJudgeResponseError('Judge did not return a valid structured result')
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
  | { findings: JudgeFinding[], ok: true } {
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
      findings: parse(judgeResponseSchema, toolResults[0].result).findings,
      ok: true,
    }
  }
  catch (error) {
    return {
      error: stringifyUnknownError(error),
      ok: false,
      retriable: true,
    }
  }
}

function recordJudgeUsage(
  metering: RuleContext['metering'],
  model: ResolvedModel,
  response: GenerateTextResult,
  operation: string,
) {
  const usage = normalizeUsage(response.usage)

  if (!usage) {
    return
  }

  metering.recordUsage({
    inputTokens: usage.inputTokens,
    metadata: {
      operation,
    },
    modelId: model.id,
    outputTokens: usage.outputTokens,
    providerId: model.provider.id,
    totalTokens: usage.totalTokens,
  })
}

function stringifyUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

function waitBeforeRetry(attempt: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 500 * 2 ** (attempt - 1)))
}
