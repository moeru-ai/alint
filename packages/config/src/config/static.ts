import type { AlintConfig, AlintConfigItem, PluginDefinition } from '@alint-js/core'

import type { StaticPluginResolver } from '../plugins/types'

import { extname } from 'pathe'

import { parsePluginSpecifier } from '../plugins/spec'

export interface NormalizeLoadedAlintConfigOptions {
  configFile?: string
  pluginResolver?: StaticPluginResolver
}

interface ResolvedPluginCacheEntry {
  plugin: Promise<PluginDefinition>
  specifier: string
}

interface StaticConfigWrapper {
  config?: {
    group?: unknown
  }
}

export async function normalizeLoadedAlintConfig(
  value: unknown,
  options: NormalizeLoadedAlintConfigOptions = {},
): Promise<AlintConfig> {
  const config = normalizeLoadedAlintConfigShape(value, options)
  const pluginCache = new Map<string, ResolvedPluginCacheEntry>()

  return Promise.all(config.map(item =>
    resolveStaticPlugins(item as AlintConfigItem, options, pluginCache),
  ))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTomlConfig(configFile: string | undefined): boolean {
  return extname(configFile ?? '').toLowerCase() === '.toml'
}

function normalizeLoadedAlintConfigShape(
  value: unknown,
  options: NormalizeLoadedAlintConfigOptions,
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

  if (isTomlConfig(options.configFile)) {
    throw new Error('Static TOML config must use [[config.group]].')
  }

  throw new Error(
    'Static config must be a flat config array or { config: { group: [...] } }.',
  )
}

function readConfigGroup(value: unknown): undefined | unknown[] {
  if (!isPlainObject(value)) {
    return undefined
  }

  const wrapper = value as StaticConfigWrapper

  if (wrapper.config === undefined) {
    return undefined
  }

  if (!isPlainObject(wrapper.config)) {
    throw new TypeError('Static config field "config.group" must be an array.')
  }

  if (wrapper.config.group === undefined) {
    return undefined
  }

  if (!Array.isArray(wrapper.config.group)) {
    throw new TypeError('Static config field "config.group" must be an array.')
  }

  return wrapper.config.group
}

async function resolveStaticPlugins(
  item: AlintConfigItem,
  options: NormalizeLoadedAlintConfigOptions,
  pluginCache: Map<string, ResolvedPluginCacheEntry>,
): Promise<AlintConfigItem> {
  if (!item.plugins) {
    return item
  }

  const rawPlugins = item.plugins as Record<string, PluginDefinition | string>
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
      if (cachedPlugin.specifier !== specifier.raw) {
        throw new Error(
          `Static plugin "${alias}" is configured with multiple specifiers: "${cachedPlugin.specifier}" and "${specifier.raw}".`,
        )
      }

      plugins[alias] = await cachedPlugin.plugin
      continue
    }

    const resolvedPlugin = options.pluginResolver({ alias, specifier })
    pluginCache.set(alias, {
      plugin: resolvedPlugin,
      specifier: specifier.raw,
    })
    plugins[alias] = await resolvedPlugin
  }

  return changed ? { ...item, plugins } : item
}
