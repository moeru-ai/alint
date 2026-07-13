import type { RuleDefinition } from '@alint-js/core'

import type { DeclarativeRuleDefinition } from './types'

export function createStructuredRule(_rule: DeclarativeRuleDefinition): RuleDefinition {
  return {
    cache: true,
    create: () => ({}),
  }
}
