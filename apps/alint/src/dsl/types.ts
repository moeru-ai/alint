import type { RunnerConfig } from '../config/types'
import type { ClassUnit, FunctionUnit, SourceFile, SourceRuntime } from '../core/source/types'
import type { ModelRequirement, ResolvedModel } from '../models/types'

export type Awaitable<T> = Promise<T> | T

export interface DiagnosticDescriptor {
  evidence?: unknown
  filePath?: string
  loc?: DiagnosticLocation
  message: string
}

export interface DiagnosticLocation {
  end?: { column: number, line: number }
  start: { column: number, line: number }
}

export interface EnabledRule {
  id: string
  localId: string
  rule: RuleDefinition
  scope: string
  severity: Exclude<RuleSeverity, 'off'>
}

export interface AlintConfig {
  plugins?: PluginDefinition[]
  rules?: Record<string, RuleConfigEntry>
  runner?: RunnerConfig
}

export interface PluginDefinition {
  rules: Record<string, RuleDefinition>
  scope: string
}

export type RuleConfigEntry = [RuleSeverity] | RuleSeverity

export interface RuleContext {
  cwd: string
  id: string
  localId: string
  logger: {
    debug: (...args: unknown[]) => void
  }
  metering: {
    recordUsage: (usage: RuleInferenceUsageRecord) => void
  }
  model: (selector?: ModelRequirement | string) => Promise<ResolvedModel>
  report: (diagnostic: DiagnosticDescriptor) => void
  scope: string
  src: SourceRuntime
}

export interface RuleDefinition {
  create: (context: RuleContext) => RuleHandlers
  model?: ModelRequirement
}

export interface RuleHandlers {
  onClass?: (classNode: ClassUnit) => Awaitable<void>
  onFile?: (file: SourceFile) => Awaitable<void>
  onFunction?: (functionNode: FunctionUnit) => Awaitable<void>
}

export interface RuleInferenceUsageRecord {
  filePath?: string
  inputTokens?: number
  metadata?: unknown
  modelId: string
  outputTokens?: number
  providerId: string
  ruleId?: string
  totalTokens?: number
}

export interface RuleRegistry {
  enabledRules: EnabledRule[]
  rules: Map<string, RuleDefinition>
}

export type RuleSeverity = 'error' | 'off' | 'warn'
