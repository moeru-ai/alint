import { array, description, number, object, optional, picklist, pipe, string } from 'valibot'

export const builtInAgentNames = ['basic-structured', 'basic-coding-agent'] as const
export const declarativeRuleFilePattern = '**/rule.alint.{toml,yaml,yml,json,jsonc,json5}'

export type BuiltInAgentName = typeof builtInAgentNames[number]

export interface DeclarativeFinding {
  confidence?: 'high' | 'low' | 'medium'
  filePath?: string
  line: number
  message: string
  suggestion?: string
}

export interface DeclarativeFindingResponse {
  findings: DeclarativeFinding[]
}

export const declarativeFindingSchema = pipe(
  object({
    confidence: optional(pipe(
      picklist(['high', 'medium', 'low']),
      description('Confidence in this finding. Use exactly "high", "medium", or "low" when confidence is known.'),
    )),
    filePath: optional(pipe(
      string(),
      description('Path to the file that owns this finding. Omit when the finding belongs to the reviewed target file.'),
    )),
    line: pipe(
      number(),
      description('Use the left-column line number from the numbered source block.'),
    ),
    message: pipe(
      string(),
      description('Human-readable diagnostic message describing the issue.'),
    ),
    suggestion: optional(pipe(
      string(),
      description('Concrete remediation direction for the finding.'),
    )),
  }),
  description('One declarative rule finding.'),
)

export const declarativeFindingResponseSchema = pipe(
  object({
    findings: pipe(
      array(declarativeFindingSchema),
      description('All findings for the declarative rule. Return an empty array when there are no issues.'),
    ),
  }),
  description('Structured declarative rule findings.'),
)

export interface DeclarativeRuleDefinition {
  builtInAgent: BuiltInAgentName
  excludeFiles: string[]
  filePath: string
  includeFiles?: string[]
  instruction: string
  name: string
}

export interface DeclarativeRuleInput {
  builtInAgent?: unknown
  excludeFiles?: unknown
  includeFiles?: unknown
  instruction?: unknown
  name?: unknown
}

export function isBuiltInAgentName(value: unknown): value is BuiltInAgentName {
  return builtInAgentNames.includes(value as BuiltInAgentName)
}
