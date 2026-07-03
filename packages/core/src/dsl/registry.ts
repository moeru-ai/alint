import type { EffectiveAlintConfig } from '../config/config-array'
import type { EnabledRule, RuleConfigEntry, RuleDefinition, RuleRegistry, RuleSeverity } from './types'

export function buildRuleRegistry(config: Pick<EffectiveAlintConfig, 'plugins' | 'rules'>): RuleRegistry {
  const rules = new Map<string, RuleDefinition>()
  const localIds = new Map<string, string>()
  const enabledRules: EnabledRule[] = []

  for (const [alias, plugin] of Object.entries(config.plugins)) {
    for (const [localId, rule] of Object.entries(plugin.rules ?? {})) {
      const id = `${alias}/${localId}`

      if (rules.has(id)) {
        throw new Error(`Duplicate rule id "${id}".`)
      }

      rules.set(id, rule)
      localIds.set(id, localId)
    }
  }

  for (const [id, entry] of Object.entries(config.rules)) {
    const rule = rules.get(id)

    if (!rule) {
      throw new Error(`Unknown rule "${id}".`)
    }

    const severity = normalizeSeverity(entry)

    if (severity === 'off') {
      continue
    }

    enabledRules.push({
      id,
      localId: localIds.get(id) ?? id,
      rule,
      severity,
    })
  }

  return {
    enabledRules,
    rules,
  }
}

function normalizeSeverity(entry: RuleConfigEntry): RuleSeverity {
  if (Array.isArray(entry)) {
    return entry[0] ?? 'warn'
  }

  return entry ?? 'warn'
}
