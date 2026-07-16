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

type ConfigItemWithPluginRules<Plugins, Rules> = Omit<AlintConfigItem, 'plugins' | 'rules'> & {
  plugins?: Plugins
  rules?: RulesForPlugins<NonNullable<Plugins>, Rules>
}

type ConfigItemWithPlugins<Plugins> = Omit<AlintConfigItem, 'plugins' | 'rules'> & {
  plugins?: Plugins
  rules?: Record<string, RuleConfigEntry<readonly unknown[]> | undefined>
}

type RuleEntryForPlugins<Plugins, Key extends string>
  = Key extends `${infer Alias}/${infer RuleName}`
    ? Alias extends keyof Plugins & string
      ? Plugins[Alias] extends PluginDefinition<infer Rules>
        ? RuleName extends keyof Rules & string
          ? Rules[RuleName] extends RuleDefinition<infer OptionsSchema>
            ? RuleConfigEntry<RuleOptionsInput<OptionsSchema>>
            : RuleConfigEntry<readonly unknown[]>
          : RuleConfigEntry<readonly unknown[]>
        : RuleConfigEntry<readonly unknown[]>
      : RuleConfigEntry<readonly unknown[]>
    : RuleConfigEntry<readonly unknown[]>

type RulesForPlugins<Plugins, Rules> = {
  readonly [Key in keyof Rules]: Key extends string
    ? RuleEntryForPlugins<Plugins, Key>
    : never
}

type TypedConfigInput<Item>
  = Item extends readonly []
    ? readonly []
    : Item extends readonly [unknown, ...unknown[]]
      ? { readonly [Index in keyof Item]: TypedConfigInput<Item[Index]> }
      : Item extends readonly (infer Element)[]
        ? readonly TypedConfigInput<Element>[]
        : TypedConfigItem<Item>

type TypedConfigItem<Item> = Item extends { plugins?: infer Plugins, rules?: infer Rules }
  ? ConfigItemWithPluginRules<Plugins, Rules>
  : TypedConfigItemWithoutRuleConfig<Item>

type TypedConfigItemWithoutRuleConfig<Item> = Item extends { plugins?: infer Plugins }
  ? ConfigItemWithPlugins<Plugins>
  : AlintConfigItem

export function defineConfig<const Config extends readonly unknown[]>(
  config: Config & TypedConfigInput<Config>,
): AlintConfig
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

export function defineRule(
  rule: Omit<RuleDefinition<[]>, 'options'> & { options?: undefined },
): RuleDefinition<[]>
export function defineRule<const OptionsSchema extends RuleOptionsSchema>(
  rule: RuleDefinition<OptionsSchema> & { options: OptionsSchema },
): RuleDefinition<OptionsSchema>
export function defineRule(
  rule: unknown,
): unknown {
  return rule
}
