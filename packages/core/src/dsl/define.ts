import type { AlintConfig, PluginDefinition, RuleDefinition } from './types'

export function defineConfig(config: AlintConfig): AlintConfig {
  return config
}

export function definePlugin(plugin: PluginDefinition): PluginDefinition {
  return plugin
}

export function defineRule(rule: RuleDefinition): RuleDefinition {
  return rule
}
