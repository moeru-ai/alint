import type { RuleContext } from '@alint-js/core'
import type { JsonSchema } from '@valibot/to-json-schema'
import type { InferOutput } from 'valibot'
import type { GenerateTextResult } from 'xsai'

import { definePlugin, defineRule } from '@alint-js/core'
import { errorMessageFrom } from '@moeru/std/error'
import { toJsonSchema } from '@valibot/to-json-schema'
import { array, description, getDescription, number, object, optional, parse, picklist, pipe, string } from 'valibot'
import { generateText, rawTool } from 'xsai'

const reportFindingsToolName = 'reportFindings'
const maxJudgeAttempts = 3

export const goBoundaryFindingSchema = pipe(
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

export const goBoundaryResponseSchema = pipe(
  object({
    findings: pipe(
      array(goBoundaryFindingSchema),
      description('All warning-level Go responsibility boundary findings. Return an empty array when the file is already focused and cohesive.'),
    ),
  }),
  description('Report Go responsibility-boundary findings for this file.'),
)

type GoBoundaryFinding = InferOutput<typeof goBoundaryFindingSchema>

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

export const goBoundaryPrompt = `
You are reviewing one Go source file.

Task:
Warn about single responsibility, package boundary, and cohesive constructor problems that require semantic design judgment.

Use the code as Go code, but do not parse it with compiler-level assumptions. Reason from responsibilities, data flow, lifecycle ownership, and testability.

Core design standard:
- A Go file should have one coherent reason to change: one package boundary, one domain policy cluster, one external integration, one lifecycle owner, or one cohesive constructor family.
- Constructors should own the setup, validation, lifecycle cleanup, startup side effects, health checks, and close dependencies that make the constructed value safe to use.
- Thin module or wiring files should compose focused constructors; they should not accumulate business rules, lifecycle phases, policy constants, and unrelated integration setup.
- Domain rules, policy constants, normalization, validation, and storage-specific operations should live near the owning domain abstraction instead of in a generic orchestration file.
- Lazy setup and per-operation resource lifecycles are valid when the file is a focused adapter and each operation owns a short-lived resource coherently.
- Small helper functions are acceptable when they support a cohesive local abstraction. They become a smell when the file is mostly a chain of tiny orchestration helpers that hides one missing cohesive owner.

Report these warning-level smells:
- one file has multiple unrelated reasons to change and would be clearer as focused files inside the same package
- setup for one runtime dependency is split across small phase helpers instead of a cohesive constructor or owner type
- a generic wiring file owns business policy or constants that belong near the domain abstraction
- lifecycle or startup side effects are separated from the value whose safety depends on those effects
- code looks organized around TypeScript-style fine-grained helper orchestration rather than Go package files with cohesive ownership
- functions that perform startup side effects lack a nearby unit-testable owner or test signal

Finding granularity:
- Report fragmented orchestration separately when a responsibility cluster is spread across lifecycle registrars, phase wrappers, setup wrappers, or error wrappers.
- Report cohesive misplaced domain clusters once when a type, constant/script data, and owner operation together implement one domain concept in the wrong layer. Put the supporting type/constant/helper declarations in relatedDeclarations instead of separate findings.
- Do not collapse fragmented orchestration into only one file-level summary. A file-level summary may be useful, but it must not replace findings for the declarations that create the smell.
- Avoid file-level summary findings when they only repeat more specific cluster findings. Use a file-level summary only when the file has additional mixed responsibilities that are not already covered by specific findings.
- Report lifecycle registration functions when they own cleanup for a value constructed elsewhere.
- Report every startup mutation phase wrapper separately when several wrappers repeat the same construct/delegate/cleanup pattern or run startup side effects outside a cohesive owner.
- Report small phase/error-wrapper helpers when their main purpose is to preserve fragmented orchestration instead of a cohesive owner.
- Report constructor wrappers when they only relabel errors or lifecycle phases for another constructor and would disappear inside a focused owner.

Do not report:
- a thin module file that only wires focused constructors
- a focused file where setup, validation, lifecycle, cleanup, health checks, and related methods are owned together
- a focused integration or domain file with one clear reason to change
- a focused adapter constructor just because it stores connection settings and opens short-lived connections lazily in methods
- ordinary transport setup, authentication, parsing, encoding, deadline handling, cleanup, or command execution inside a focused adapter
- testability concerns inferred only from direct runtime API calls; report testability only when the reviewed source itself shows hidden side effects with no local owner or visible substitute path
- isolated small helpers that support a cohesive file-local abstraction

few-shot examples:
- Negative example: a package wiring file constructs a shared runtime resource, registers lifecycle hooks elsewhere, runs startup mutations through separate phase wrappers, and also stores unrelated business defaults for another domain. Report the lifecycle registrar, every phase/error wrapper, every startup mutation helper, and the misplaced domain-policy owner.
- Negative example: an integration adapter file is otherwise low-level, but a result type, embedded operation data, and a method together implement one business concept. Report one finding at the owner method and list the result type and embedded data in relatedDeclarations.
- Positive example: a module file only provides focused constructors while each dependency has its own file where setup, lifecycle cleanup, health checks, and related methods are owned together. Return no findings for the module file.
- Positive example: a large file can be acceptable when every function supports one cohesive abstraction with focused setup, retry behavior, cleanup, and health checks.
- Positive example: a focused adapter may parse configuration at construction time and open, authenticate, use, and close a short-lived connection inside each operation. Return no finding for that lifecycle shape unless unrelated domain policy is also mixed in.

Do not treat example names, domains, packages, or technologies as trigger terms. Use them only to infer the higher-level design distinction between cohesive ownership and mixed responsibility.

Do not key findings on exact function names. Do not require specific identifiers to appear. Do not use textual pattern matching as the basis of the decision. The same smell should be found when functions are renamed.

Return warnings only. If uncertain, use medium or low confidence instead of forcing a finding.
`.trim()

const reportFindingsTool = rawTool({
  description: getDescription(goBoundaryResponseSchema),
  execute: input => asRecord(input) ?? {},
  name: reportFindingsToolName,
  parameters: createReportFindingsToolParameters(),
  strict: true,
})

export const goBoundaryPlugin = definePlugin({
  configs: {
    recommended: [
      {
        files: ['**/*.go'],
        language: 'text/plain',
        rules: {
          'go/responsibility-boundary': 'warn',
        },
      },
    ],
  },
  rules: {
    'responsibility-boundary': defineRule({
      create: ctx => ({
        async onTarget(target) {
          if (target.kind !== 'file' || !target.file.path.endsWith('.go')) {
            return
          }

          const findings = await judgeGoBoundary(ctx, ctx.src.getText(target))

          reportGoBoundaryFindings(ctx, target.file.path, findings)
        },
      }),
    }),
  },
})

export default goBoundaryPlugin

export function createGoBoundaryMessages(source: string, previousError: string | undefined, outputLanguage?: string) {
  return [
    {
      content: goBoundaryPrompt,
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
        `Go code with line numbers:\n\n${formatSourceWithLineNumbers(source)}`,
      ].filter(Boolean).join('\n\n'),
      role: 'user' as const,
    },
  ]
}

export function createReportFindingsToolParameters(): JsonSchema {
  return normalizeToolJsonSchema(toJsonSchema(goBoundaryResponseSchema))
}

export function reportGoBoundaryFindings(
  ctx: RuleContext,
  filePath: string,
  findings: readonly GoBoundaryFinding[],
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

async function judgeGoBoundary(
  ctx: RuleContext,
  source: string,
): Promise<GoBoundaryFinding[]> {
  const model = await ctx.model()
  let previousError: string | undefined

  for (let attempt = 1; attempt <= maxJudgeAttempts; attempt += 1) {
    let response: GenerateTextResult

    try {
      response = await generateText({
        baseURL: model.provider.endpoint,
        headers: model.provider.headers,
        messages: createGoBoundaryMessages(source, previousError, ctx.outputLanguage),
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
      ctx.logger.debug(`Go boundary judge attempt ${attempt} failed while calling the model: ${previousError}`)

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
    ctx.logger.debug(`Go boundary judge attempt ${attempt} returned an invalid structured result: ${previousError}`)

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
  | { findings: GoBoundaryFinding[], ok: true } {
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
      findings: parse(goBoundaryResponseSchema, toolResults[0].result).findings,
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
  return new Promise(resolve => setTimeout(resolve, 500 * 2 ** (attempt - 1)))
}
