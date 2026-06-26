import type { EnabledRule, AlintConfig, RuleConfigEntry, RuleDefinition, RuleRegistry, RuleSeverity } from './types'

export function buildRuleRegistry(config: AlintConfig): RuleRegistry {
  const rules = new Map<string, RuleDefinition>()
  const enabledRules: EnabledRule[] = []

  for (const plugin of config.plugins ?? []) {
    for (const [localId, rule] of Object.entries(plugin.rules)) {
      const id = `${plugin.scope}/${localId}`

      if (rules.has(id)) {
        throw new Error(`Duplicate rule id "${id}".`)
      }

      rules.set(id, rule)
      const severity = normalizeSeverity(config.rules?.[id])

      if (severity !== 'off') {
        enabledRules.push({
          id,
          localId,
          rule,
          scope: plugin.scope,
          severity,
        })
      }
    }
  }

  for (const id of Object.keys(config.rules ?? {})) {
    if (!rules.has(id)) {
      throw new Error(`Unknown rule "${id}".`)
    }
  }

  return {
    enabledRules,
    rules,
  }
}

function normalizeSeverity(entry: RuleConfigEntry | undefined): RuleSeverity {
  if (Array.isArray(entry)) {
    return entry[0] ?? 'warn'
  }

  return entry ?? 'warn'
}
