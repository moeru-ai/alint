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
