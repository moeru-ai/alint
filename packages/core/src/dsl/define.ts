import type {
  AlintConfig,
  AlintConfigInput,
  AlintConfigItem,
  PluginDefinition,
  RuleConfigEntry,
  RuleDefinition,
  RuleOptionsInput,
  RuleOptionsSchema,
} from './types'

type AnyRuleDefinition = RuleDefinition<any>

type RuleEntriesFromPlugins<Plugins> = {
  [Alias in keyof Plugins & string as
  Plugins[Alias] extends PluginDefinition<infer Rules>
    ? `${Alias}/${keyof Rules & string}`
    : never
  ]?: Plugins[Alias] extends PluginDefinition<infer Rules>
    ? {
        [RuleName in keyof Rules & string as `${Alias}/${RuleName}`]:
        Rules[RuleName] extends RuleDefinition<infer OptionsSchema>
          ? RuleConfigEntry<RuleOptionsInput<OptionsSchema>>
          : RuleConfigEntry
      }[`${Alias}/${keyof Rules & string}`]
    : never
}

type RulesForPlugins<Plugins>
  = & Record<string, RuleConfigEntry<readonly unknown[]> | undefined>
    & RuleEntriesFromPlugins<Plugins>

type TypedConfigInput<Item>
  = Item extends readonly []
    ? readonly []
    : Item extends readonly [unknown, ...unknown[]]
      ? { readonly [Index in keyof Item]: TypedConfigInput<Item[Index]> }
      : TypedConfigItem<Item>

type TypedConfigItem<Item> = Item extends { plugins?: infer Plugins }
  ? Omit<AlintConfigItem, 'plugins' | 'rules'> & {
    plugins?: Plugins
    rules?: RulesForPlugins<NonNullable<Plugins>>
  }
  : AlintConfigItem

export function defineConfig<const Config extends readonly unknown[]>(
  config: Config & TypedConfigInput<Config>,
): AlintConfig
export function defineConfig(config: readonly AlintConfigInput[]): AlintConfig
export function defineConfig(config: readonly AlintConfigInput[]): AlintConfig {
  return config
}

export function definePlugin<
  const Rules extends Record<string, AnyRuleDefinition> = Record<string, AnyRuleDefinition>,
>(
  plugin: Omit<PluginDefinition<Rules>, 'rules'> & { rules?: Rules },
): PluginDefinition<Rules> {
  return plugin
}

export function defineRule<const OptionsSchema extends RuleOptionsSchema = []>(
  rule: RuleDefinition<OptionsSchema>,
): RuleDefinition<OptionsSchema> {
  return rule
}
