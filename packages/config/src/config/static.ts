import type { AlintConfig, AlintConfigItem, PluginDefinition } from '@alint-js/core'

import { extname } from 'pathe'
import {
  array,
  boolean,
  looseObject,
  optional,
  parse,
  picklist,
  record,
  string,
  tuple,
  union,
  unknown,
} from 'valibot'

export interface NormalizeLoadedAlintConfigOptions {
  configFile?: string
}

export interface ParsedPluginSpecifier {
  name: string
  raw: string
  version?: string
}

export interface ParsedStaticConfig {
  groups: ParsedStaticConfigGroup[]
}

export interface ParsedStaticConfigGroup {
  item: AlintConfigItem
  plugins: StaticPluginReference[]
}

export interface ParseStaticConfigOptions {
  configFile?: string
}

export interface StaticPluginReference {
  alias: string
  specifier: ParsedPluginSpecifier
}

export type StaticPluginResolver = (
  reference: StaticPluginReference,
) => Promise<PluginDefinition>

export interface ToAlintConfigOptions {
  pluginResolver: StaticPluginResolver
}

interface StaticConfigWrapper {
  config?: {
    group?: unknown
  }
}

const ruleSeveritySchema = picklist(['error', 'off', 'warn'])
const ruleConfigEntrySchema = union([ruleSeveritySchema, tuple([ruleSeveritySchema])])
const filePatternSchema = union([string(), array(string())])
const staticConfigItemSchema = looseObject({
  agent: optional(unknown()),
  basePath: optional(string()),
  extends: optional(array(unknown())),
  files: optional(array(filePatternSchema)),
  ignore: optional(looseObject({
    gitignore: optional(boolean()),
  })),
  ignores: optional(array(string())),
  language: optional(string()),
  languageOptions: optional(record(string(), unknown())),
  linterOptions: optional(looseObject({
    noInlineConfig: optional(boolean()),
    reportUnusedDisableDirectives: optional(ruleSeveritySchema),
  })),
  name: optional(string()),
  plugins: optional(record(string(), unknown())),
  processor: optional(unknown()),
  rules: optional(record(string(), ruleConfigEntrySchema)),
  runner: optional(unknown()),
  settings: optional(record(string(), unknown())),
})
const staticConfigItemsSchema = array(staticConfigItemSchema)

export function formatPluginSpecifier(specifier: ParsedPluginSpecifier): string {
  return specifier.raw
}

export function normalizeLoadedAlintConfig(
  value: unknown,
  options: NormalizeLoadedAlintConfigOptions = {},
): AlintConfig {
  return toAlintConfigItems(value, options) as AlintConfig
}

export function parsePluginSpecifier(value: string): ParsedPluginSpecifier {
  const versionSeparator = value.lastIndexOf('@')

  if (versionSeparator > 0) {
    return {
      name: value.slice(0, versionSeparator),
      raw: value,
      version: value.slice(versionSeparator + 1),
    }
  }

  return {
    name: value,
    raw: value,
  }
}

export function parseStaticConfig(
  value: unknown,
  options: ParseStaticConfigOptions = {},
): ParsedStaticConfig {
  const items = toAlintConfigItems(value, options)
  const pluginsByAlias = new Map<string, ParsedPluginSpecifier>()
  const groups = items.map((item): ParsedStaticConfigGroup => {
    const plugins = readStaticPluginReferences(item, pluginsByAlias)

    return {
      item: item as AlintConfigItem,
      plugins,
    }
  })

  return { groups }
}

export async function toAlintConfig(
  config: ParsedStaticConfig,
  options: ToAlintConfigOptions,
): Promise<AlintConfig> {
  const pluginCache = new Map<string, Promise<PluginDefinition>>()

  return Promise.all(config.groups.map(group =>
    resolveStaticPlugins(group, options, pluginCache),
  ))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTomlConfig(configFile: string | undefined): boolean {
  return extname(configFile ?? '').toLowerCase() === '.toml'
}

function readConfigGroup(value: unknown): undefined | unknown[] {
  if (!isPlainObject(value)) {
    return undefined
  }

  const wrapper = value as StaticConfigWrapper

  if (wrapper.config === undefined) {
    return undefined
  }

  if (!isPlainObject(wrapper.config) || !Array.isArray(wrapper.config.group)) {
    throw new TypeError('Static config field "config.group" must be an array.')
  }

  return wrapper.config.group
}

function readStaticPluginReferences(
  item: unknown,
  pluginsByAlias: Map<string, ParsedPluginSpecifier>,
): StaticPluginReference[] {
  if (!isPlainObject(item) || !isPlainObject(item.plugins)) {
    return []
  }

  const references: StaticPluginReference[] = []

  for (const [alias, plugin] of Object.entries(item.plugins)) {
    if (typeof plugin !== 'string') {
      continue
    }

    const specifier = parsePluginSpecifier(plugin)
    const existing = pluginsByAlias.get(alias)

    if (existing !== undefined && formatPluginSpecifier(existing) !== formatPluginSpecifier(specifier)) {
      throw new Error(
        `Static plugin "${alias}" is configured with multiple specifiers: "${formatPluginSpecifier(existing)}" and "${formatPluginSpecifier(specifier)}".`,
      )
    }

    pluginsByAlias.set(alias, specifier)
    references.push({ alias, specifier })
  }

  return references
}

async function resolveStaticPlugins(
  group: ParsedStaticConfigGroup,
  options: ToAlintConfigOptions,
  pluginCache: Map<string, Promise<PluginDefinition>>,
): Promise<AlintConfigItem> {
  if (group.plugins.length === 0) {
    return group.item
  }

  const rawPlugins = group.item.plugins as Record<string, PluginDefinition | string>
  const plugins: Record<string, PluginDefinition> = {}

  for (const [alias, plugin] of Object.entries(rawPlugins)) {
    if (typeof plugin !== 'string') {
      plugins[alias] = plugin
      continue
    }

    let resolvedPlugin = pluginCache.get(alias)

    if (resolvedPlugin === undefined) {
      const reference = group.plugins.find(item => item.alias === alias)

      if (reference === undefined) {
        throw new Error(`Static plugin "${alias}" is missing a parsed plugin reference.`)
      }

      resolvedPlugin = options.pluginResolver(reference)
      pluginCache.set(alias, resolvedPlugin)
    }

    plugins[alias] = await resolvedPlugin
  }

  return { ...group.item, plugins }
}

function toAlintConfigItems(
  value: unknown,
  options: ParseStaticConfigOptions = {},
): AlintConfigItem[] {
  if (Array.isArray(value)) {
    return parse(staticConfigItemsSchema, value) as AlintConfigItem[]
  }

  const group = readConfigGroup(value)

  if (group !== undefined) {
    return parse(staticConfigItemsSchema, group) as AlintConfigItem[]
  }

  if (isTomlConfig(options.configFile)) {
    throw new Error('Static TOML config must use [[config.group]].')
  }

  if (value === undefined || value === null) {
    return []
  }

  throw new Error(
    'Static config must be a flat config array or { config: { group: [...] } }.',
  )
}
