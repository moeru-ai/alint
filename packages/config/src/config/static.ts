import type { AlintConfig, AlintConfigItem, PluginDefinition } from '@alint-js/core'

import type { ParsedPluginSpecifier, StaticPluginResolver } from '../plugins/types'

import { isPlainObject } from 'es-toolkit/compat'
import { extname } from 'pathe'
import { array, object, optional, safeParse, unknown } from 'valibot'

import { formatPluginSpecifier, parsePluginSpecifier } from '../plugins/spec'

export interface ToAlintConfigOptions {
  configFile?: string
  pluginResolver?: StaticPluginResolver
}

interface ResolvedPluginCacheEntry {
  plugin: Promise<PluginDefinition>
  specifier: ParsedPluginSpecifier
}

const ConfigGroupWrapperSchema = object({
  config: optional(object({
    group: optional(array(unknown())),
  })),
})

export async function toAlintConfig(
  value: unknown,
  options: ToAlintConfigOptions = {},
): Promise<AlintConfig> {
  const config = toAlintConfigItems(value, options)
  const pluginCache = new Map<string, ResolvedPluginCacheEntry>()

  return Promise.all(config.map(item =>
    resolveStaticPlugins(item as AlintConfigItem, options, pluginCache),
  ))
}

function readConfigGroup(value: unknown): undefined | unknown[] {
  if (!isPlainObject(value)) {
    return undefined
  }

  const wrapper = value as Record<string, unknown>

  if (!('config' in wrapper)) {
    return undefined
  }

  const result = safeParse(ConfigGroupWrapperSchema, value)

  if (!result.success) {
    throw new TypeError('Static config field "config.group" must be an array.')
  }

  return result.output.config?.group
}

async function resolveStaticPlugins(
  item: AlintConfigItem,
  options: ToAlintConfigOptions,
  pluginCache: Map<string, ResolvedPluginCacheEntry>,
): Promise<AlintConfigItem> {
  if (!item.plugins) {
    return item
  }

  const rawPlugins: Record<string, PluginDefinition | string> = item.plugins as Record<string, PluginDefinition | string>
  const plugins: Record<string, PluginDefinition> = {}
  let changed = false

  for (const [alias, plugin] of Object.entries(rawPlugins)) {
    if (typeof plugin !== 'string') {
      plugins[alias] = plugin
      continue
    }

    changed = true

    if (!options.pluginResolver) {
      throw new Error(`Static plugin "${alias}" requires a plugin resolver.`)
    }

    const specifier = parsePluginSpecifier(plugin)
    const cachedPlugin = pluginCache.get(alias)

    if (cachedPlugin) {
      if (formatPluginSpecifier(cachedPlugin.specifier) !== formatPluginSpecifier(specifier)) {
        throw new Error(
          `Static plugin "${alias}" is configured with multiple specifiers: "${formatPluginSpecifier(cachedPlugin.specifier)}" and "${formatPluginSpecifier(specifier)}".`,
        )
      }

      plugins[alias] = await cachedPlugin.plugin
      continue
    }

    const resolvedPlugin = options.pluginResolver({ alias, specifier })
    pluginCache.set(alias, {
      plugin: resolvedPlugin,
      specifier,
    })
    plugins[alias] = await resolvedPlugin
  }

  return changed ? { ...item, plugins } : item
}

function toAlintConfigItems(
  value: unknown,
  options: ToAlintConfigOptions,
): AlintConfig {
  if (value === undefined || value === null) {
    return []
  }

  if (Array.isArray(value)) {
    return value as AlintConfig
  }

  const group = readConfigGroup(value)

  if (group !== undefined) {
    return group as AlintConfig
  }

  if (extname(options.configFile ?? '').toLowerCase() === '.toml') {
    throw new Error('Static TOML config must use [[config.group]].')
  }

  throw new Error(
    'Static config must be a flat config array or { config: { group: [...] } }.',
  )
}
