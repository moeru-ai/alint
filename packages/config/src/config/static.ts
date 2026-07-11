import type { AlintConfig } from '@alint-js/core'

import { extname } from 'pathe'

export interface NormalizeLoadedAlintConfigOptions {
  configFile?: string
}

interface StaticConfigWrapper {
  config?: {
    group?: unknown
  }
}

export function normalizeLoadedAlintConfig(
  value: unknown,
  options: NormalizeLoadedAlintConfigOptions = {},
): AlintConfig {
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

  if (value === undefined || value === null) {
    return []
  }

  throw new Error(
    'Static config must be a flat config array or { config: { group: [...] } }.',
  )
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
