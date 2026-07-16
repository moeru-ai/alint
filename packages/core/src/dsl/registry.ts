import type { BaseIssue, GenericSchema, InferOutput } from 'valibot'

import type { EffectiveAlintConfig } from '../config/config-array'
import type { EnabledRule, RuleConfigEntry, RuleDefinition, RuleOptionsSchema, RuleRegistry, RuleSeverity } from './types'

import { getDotPath, safeParse } from 'valibot'

type RuleRegistryConfig = Pick<EffectiveAlintConfig, 'plugins'> & {
  rules: Record<string, RuleConfigEntry<readonly unknown[]>>
}

export function buildRuleRegistry(config: RuleRegistryConfig): RuleRegistry {
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

    const normalizedEntry = normalizeRuleConfigEntry(entry)
    const severity = normalizedEntry.severity

    if (severity === 'off') {
      continue
    }

    enabledRules.push({
      id,
      localId: localIds.get(id) ?? id,
      options: parseRuleOptions(id, rule.options, normalizedEntry.options),
      rule,
      severity,
    })
  }

  return {
    enabledRules,
    rules,
  }
}

function formatRuleOptionIssues(index: number, issues: BaseIssue<unknown>[]): string {
  return issues
    .map((issue) => {
      const path = getDotPath(issue)

      return path === null
        ? `"${index}": ${issue.message}`
        : `"${index}.${path}": ${issue.message}`
    })
    .join('; ')
}

function isRuleConfigTuple(entry: RuleConfigEntry<readonly unknown[]>): entry is readonly [RuleSeverity, ...readonly unknown[]] {
  return Array.isArray(entry)
}

function normalizeRuleConfigEntry(entry: RuleConfigEntry<readonly unknown[]>): { options: readonly unknown[], severity: RuleSeverity } {
  if (isRuleConfigTuple(entry)) {
    const [severity = 'warn', ...options] = entry

    return { options, severity }
  }

  return { options: [], severity: entry ?? 'warn' }
}

function parseRuleOption<Schema extends GenericSchema>(
  id: string,
  index: number,
  schema: Schema,
  value: unknown,
): InferOutput<Schema> {
  const result = safeParse(schema, value)

  if (result.success) {
    return result.output
  }

  if (value === undefined) {
    const emptyObjectResult = safeParse(schema, {})

    if (emptyObjectResult.success) {
      return emptyObjectResult.output
    }
  }

  throw new TypeError(`Invalid options for rule "${id}": ${formatRuleOptionIssues(index, result.issues)}`)
}

function parseRuleOptions(
  id: string,
  schema: RuleOptionsSchema | undefined,
  options: readonly unknown[],
): readonly unknown[] {
  if (!schema) {
    if (options.length > 0) {
      throw new TypeError(`Rule "${id}" does not accept options.`)
    }

    return []
  }

  if (options.length > schema.length) {
    throw new TypeError(`Invalid options for rule "${id}": Unexpected option at index ${schema.length}.`)
  }

  return schema.map((optionSchema, index) => parseRuleOption(id, index, optionSchema, options[index]))
}
