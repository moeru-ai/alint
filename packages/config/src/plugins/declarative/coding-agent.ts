import type { RuleDefinition } from '@alint-js/core'

import type { DeclarativeRuleDefinition } from './types'

export function createCodingAgentRule(_rule: DeclarativeRuleDefinition): RuleDefinition {
  return {
    cache: false,
    create: () => ({}),
  }
}
