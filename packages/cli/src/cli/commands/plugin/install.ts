import type { ParsedPluginSpecifier } from '@alint-js/config'

import { stat } from 'node:fs/promises'

import { installStaticPlugin, loadAlintConfig } from '@alint-js/config'
import { resolve } from 'pathe'

import { defineCommand } from '../command'

const defaultRegistry = 'https://registry.npmjs.org/'
const globalOptionNames = new Set([
  'cache',
  'cacheLocation',
  'config',
  'fileConcurrency',
  'format',
  'lang',
  'model',
  'progress',
  'ruleConcurrency',
  'stats',
  'timeoutMs',
])
const supportedApiVersion = '1'

interface StaticPluginReference {
  alias: string
  specifier: ParsedPluginSpecifier
}

export const install = defineCommand({
  action: (context, options: { config?: unknown, registry?: unknown }) =>
    runPluginInstallCommand(options, context.io),
  description: 'Install plugins referenced by static config',
  name: 'install',
  options: [
    { description: 'Path to alint config file', flags: '--config <path>' },
    { description: 'npm registry URL', flags: '--registry <url>' },
  ],
  strictArguments: true,
})

async function assertConfigExists(cwd: string, configPath: string): Promise<void> {
  const resolvedConfigPath = resolve(cwd, configPath)

  try {
    const stats = await stat(resolvedConfigPath)

    if (!stats.isFile()) {
      throw new Error(`Config file "${configPath}" is not a file.`)
    }
  }
  catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new Error(`Config file "${configPath}" does not exist.`)
    }

    throw error
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function rejectUnsupportedInstallOptions(options: Record<string, unknown>): void {
  rejectUnsupportedOptions(options, new Set([...globalOptionNames, 'registry']))
}

function rejectUnsupportedOptions(options: Record<string, unknown>, allowed: Set<string>): void {
  for (const key of Object.keys(options)) {
    if (key === '--') {
      continue
    }

    if (!allowed.has(key)) {
      throw new Error(`Unsupported option --${key}.`)
    }
  }
}

function resolveConfigOption(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('Config file path must be a non-empty string.')
  }

  return value
}

function resolveRegistryOption(value: unknown): string {
  if (value === undefined) {
    return defaultRegistry
  }

  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('Registry URL must be a non-empty absolute URL.')
  }

  let url: URL

  try {
    url = new URL(value)
  }
  catch (error) {
    throw new Error('Registry URL must be a non-empty absolute URL.', {
      cause: error,
    })
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Registry URL must use http: or https:.')
  }

  return value
}

async function runPluginInstallCommand(
  options: { config?: unknown, registry?: unknown },
  io: { cwd: string, stdout: { write: (chunk: string) => void } },
): Promise<number> {
  rejectUnsupportedInstallOptions(options)

  const config = resolveConfigOption(options.config)
  const registry = resolveRegistryOption(options.registry)

  if (config !== undefined) {
    await assertConfigExists(io.cwd, config)
  }

  const references: StaticPluginReference[] = []

  await loadAlintConfig(io.cwd, config, {
    pluginResolver: async (reference) => {
      references.push(reference)
      return { rules: {} }
    },
  })

  for (const reference of references) {
    const installed = await installStaticPlugin(io.cwd, {
      alias: reference.alias,
      registry,
      specifier: reference.specifier,
      supportedApiVersion,
    })
    io.stdout.write(`Installed ${installed.lockEntry.specifier} as ${reference.alias}\n`)
  }

  if (references.length === 0) {
    io.stdout.write('No static plugins found.\n')
  }

  return 0
}
