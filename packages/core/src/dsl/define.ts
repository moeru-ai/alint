import type { AlintConfig, AlintConfigInput, PluginDefinition, RuleDefinition } from './types'

export function defineConfig(config: readonly AlintConfigInput[]): AlintConfig {
  return config
}

export function definePlugin(plugin: PluginDefinition): PluginDefinition {
  return plugin
}

export function defineRule(rule: RuleDefinition): RuleDefinition {
  return rule
}
