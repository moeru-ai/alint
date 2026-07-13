import type { PluginDefinition, RuleDefinition } from '@alint-js/core'

import type { DeclarativeRuleDefinition } from './types'

import { createCodingAgentRule } from './coding-agent'
import { createStructuredRule } from './structured'

export interface CreateDeclarativePluginOptions {
  rules: readonly DeclarativeRuleDefinition[]
}

export function createDeclarativePlugin(options: CreateDeclarativePluginOptions): PluginDefinition {
  return {
    rules: Object.fromEntries(options.rules.map(rule => [rule.name, createDeclarativeRule(rule)])),
  }
}

function createDeclarativeRule(rule: DeclarativeRuleDefinition): RuleDefinition {
  if (rule.builtInAgent === 'basic-coding-agent') {
    return createCodingAgentRule(rule)
  }

  return createStructuredRule(rule)
}
