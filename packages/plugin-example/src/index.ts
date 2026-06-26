import type { JsonSchema } from '@valibot/to-json-schema'
import type { RuleContext } from 'alint'
import type { GenerateTextResult } from 'xsai'

import { toJsonSchema } from '@valibot/to-json-schema'
import { definePlugin, defineRule } from 'alint'
import { generateText, rawTool } from 'xsai'

import * as v from 'valibot'

const reportFindingsToolName = 'reportFindings'
const maxJudgeAttempts = 3

const judgeFindingSchema = v.pipe(
  v.object({
    confidence: v.pipe(
      v.picklist(['high', 'medium', 'low']),
      v.description('Confidence in this finding. Use exactly "low", "medium", or "high" without punctuation.'),
    ),
    line: v.pipe(
      v.number(),
      v.description([
        'Use the function declaration line of the specific helper being reported.',
        'Use the left-column line number from the numbered code block.',
        'Do not use the caller parser/normalizer line just because it orchestrates the helpers.',
      ].join(' ')),
    ),
    message: v.pipe(
      v.string(),
      v.description([
        'Mention the specific helper function being reported.',
        'Mention the target object/type/value category if visible.',
        'Explain that it is part of a private parsing toolkit.',
        'Do not list other helper names in the message; describe the cluster at the design level.',
        'Keep the message short.',
      ].join(' ')),
    ),
    suggestion: v.pipe(
      v.string(),
      v.description([
        'Provide one concrete remediation direction.',
        'Prefer a schema validation library or shared parsing utility.',
        'Do not propose a code patch.',
        'Do not list other helper names; describe the helper cluster at the design level.',
        'Keep the suggestion under 35 words.',
      ].join(' ')),
    ),
  }),
  v.description('One warning-level report for a helper function that belongs to the private parsing toolkit.'),
)

const judgeResponseSchema = v.pipe(
  v.object({
    findings: v.pipe(
      v.array(judgeFindingSchema),
      v.description('All warning-level findings. Return an empty array when there is no qualifying private reader/narrowing toolkit.'),
    ),
  }),
  v.description('Report findings for this TypeScript file.'),
)

type JudgeFinding = v.InferOutput<typeof judgeFindingSchema>

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

const inlineMiniatureNormalizerPrompt = `
You are reviewing one TypeScript file.

Task:
Warn about private reader/narrowing toolkits.

Look for clusters of local helper functions that mechanically parse, validate, pick, or narrow unknown, any, JSON-like, message, command, event, config, or transport payload values into primitives, records, arrays, literal unions, optional values, or simple typed fields.

This is a warning-level design smell, not a correctness error.

The issue:
A file is avoiding shared parser/decoder/schema utilities by creating a private parsing toolkit inside the file. This often appears as:
- local helper functions that accept unknown, any, or loosely typed input
- helpers that return primitive values, records, arrays, literal unions, optional values, or simple field values after type checks
- helpers that receive labels, paths, field names, or error text only to produce validation errors
- helpers that call each other to add generic constraints such as non-empty strings, finite numbers, string maps, object records, arrays, ids, dates, booleans, etc.
- helpers that silently return undefined for failed picks instead of throwing validation errors
- helpers that trim, cast, or reshape values as part of generic payload parsing
- the helpers are mechanical and reusable, not domain behavior

Do not key on helper names. Infer the pattern from data flow:
external or loose input -> local generic reader/narrowing helpers -> typed values or a typed object.

First decide whether a file has a qualifying cluster of at least two local generic reader/narrowing helpers.
If there is no qualifying cluster, return no findings.
If there is a qualifying cluster, report each function that belongs to that private parsing toolkit as a separate finding.

Report tiny leaf helpers even when they are only a few lines long, if they perform generic narrowing such as unknown-to-record, record-field-to-number, string trimming, finite-number checks, array-of-string checks, literal-union checks, or failed-pick-to-undefined behavior.
Report orchestration functions when they are part of that private parsing toolkit, even if they mainly call helper functions, assemble a typed object, map provider-specific field names, normalize usage/token objects, or otherwise coordinate helper results.

Selection example:
- If a normalizer accepts an unknown payload, calls a local unknown-to-record helper, then calls local field readers to build a typed object, report the normalizer, the leaf helper functions, and the field-reader functions.
- Report the whole private toolkit, not only the smallest helpers.

Do not report:
- dedicated parser/decoder/schema modules
- exported public type guards intended for reuse
- complex domain validation
- isolated inline checks
- code already using a shared decoder/schema utility

Return warnings only. If uncertain, use medium or low confidence instead of forcing a finding.
`.trim()

const reportFindingsTool = rawTool({
  description: v.getDescription(judgeResponseSchema),
  execute: input => asRecord(input) ?? {},
  name: reportFindingsToolName,
  parameters: createReportFindingsToolParameters(),
  strict: true,
})

export const examplePlugin = definePlugin({
  rules: {
    'inline-miniature-normalizer': defineRule({
      create: ctx => ({
        async onFile(file) {
          const findings = await judgeInlineMiniatureNormalizers(ctx, file.text)

          for (const finding of findings) {
            ctx.report({
              evidence: {
                confidence: finding.confidence,
                suggestion: finding.suggestion,
              },
              filePath: file.path,
              loc: {
                start: {
                  column: 0,
                  line: finding.line,
                },
              },
              message: finding.message,
            })
          }
        },
      }),
    }),
  },
  scope: '@alint-js/plugin-example',
})

export default examplePlugin

export function createJudgeMessages(source: string, previousError: string | undefined) {
  return [
    {
      content: inlineMiniatureNormalizerPrompt,
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
      content: `Code with line numbers:\n\n${formatSourceWithLineNumbers(source)}`,
      role: 'user' as const,
    },
  ]
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function createReportFindingsToolParameters(): JsonSchema {
  return normalizeToolJsonSchema(toJsonSchema(judgeResponseSchema))
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

async function judgeInlineMiniatureNormalizers(
  ctx: RuleContext,
  source: string,
): Promise<JudgeFinding[]> {
  const model = await ctx.model()
  let previousError: string | undefined

  for (let attempt = 1; attempt <= maxJudgeAttempts; attempt += 1) {
    let response: GenerateTextResult

    try {
      response = await generateText({
        baseURL: model.provider.endpoint,
        headers: model.provider.headers,
        messages: createJudgeMessages(source, previousError),
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
      previousError = `Tool call failed before validation: ${stringifyUnknownError(error)}`
      ctx.logger.debug(`Judge attempt ${attempt} failed while calling the model: ${previousError}`)

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
    ctx.logger.debug(`Judge attempt ${attempt} returned an invalid structured result: ${previousError}`)

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
      findings: v.parse(judgeResponseSchema, toolResults[0].result).findings,
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

function recordJudgeUsage(ctx: RuleContext, model: Awaited<ReturnType<RuleContext['model']>>, response: GenerateTextResult) {
  const usage = normalizeUsage(response.usage)

  if (!usage) {
    return
  }

  ctx.metering.recordUsage({
    inputTokens: usage.inputTokens,
    metadata: {
      operation: 'inline-miniature-normalizer-judge',
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

export { createReportFindingsToolParameters, inlineMiniatureNormalizerPrompt, judgeFindingSchema, judgeResponseSchema }
