import type { StaticPluginReference } from '@alint-js/config'

import { stat } from 'node:fs/promises'

import { installStaticPlugin, loadAlintConfig } from '@alint-js/config'
import { resolve } from 'pathe'
import { array, check, nonEmpty, optional, parse, pipe, strictObject, string, unknown, url } from 'valibot'

import { isNodeError } from '../../nodeError'
import { defineCommand } from '../command'

const defaultRegistry = 'https://registry.npmjs.org/'
const PluginInstallOptionsSchema = strictObject({
  '--': optional(array(unknown())),
  'cache': optional(unknown()),
  'cacheLocation': optional(unknown()),
  'config': optional(pipe(
    string('Config file path must be a non-empty string.'),
    nonEmpty('Config file path must be a non-empty string.'),
  )),
  'fileConcurrency': optional(unknown()),
  'format': optional(unknown()),
  'lang': optional(unknown()),
  'model': optional(unknown()),
  'progress': optional(unknown()),
  'registry': optional(pipe(
    string('Registry URL must be a non-empty absolute URL.'),
    nonEmpty('Registry URL must be a non-empty absolute URL.'),
    url('Registry URL must be a non-empty absolute URL.'),
    check((value) => {
      if (!URL.canParse(value)) {
        return true
      }

      const protocol = new URL(value).protocol
      return protocol === 'http:' || protocol === 'https:'
    }, 'Registry URL must use http: or https:.'),
  )),
  'ruleConcurrency': optional(unknown()),
  'stats': optional(unknown()),
  'timeoutMs': optional(unknown()),
})

interface PluginInstallOptions {
  config?: string
  registry: string
}

interface PluginInstallOptionsIssue {
  message: string
  path?: Array<{
    key?: unknown
    origin?: unknown
  }>
  type?: string
}

export const install = defineCommand({
  action: (context, options: Record<string, unknown>) =>
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

function parsePluginInstallOptions(options: Record<string, unknown>): PluginInstallOptions {
  try {
    const parsed = parse(PluginInstallOptionsSchema, options)

    return {
      config: parsed.config,
      registry: parsed.registry ?? defaultRegistry,
    }
  }
  catch (error) {
    const issues = pluginInstallOptionsIssues(error)

    if (issues === undefined) {
      throw error
    }

    const unsupportedOption = issues
      .find(issue => issue.type === 'strict_object')
      ?.path
      ?.find(item => item.origin === 'key')
      ?.key

    if (typeof unsupportedOption === 'string') {
      throw new TypeError(`Unsupported option --${unsupportedOption}.`, { cause: error })
    }

    throw new Error(issues[0]?.message ?? 'Invalid plugin install options.', { cause: error })
  }
}

function pluginInstallOptionsIssues(error: unknown): PluginInstallOptionsIssue[] | undefined {
  if (!(error instanceof Error) || !('issues' in error)) {
    return undefined
  }

  const issues = error.issues

  if (!Array.isArray(issues)) {
    return undefined
  }

  return issues.filter(issue =>
    typeof issue === 'object'
    && issue !== null
    && 'message' in issue
    && typeof issue.message === 'string',
  ) as PluginInstallOptionsIssue[]
}

async function runPluginInstallCommand(
  options: Record<string, unknown>,
  io: { cwd: string, stdout: { write: (chunk: string) => void } },
): Promise<number> {
  const { config, registry } = parsePluginInstallOptions(options)

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
    })
    io.stdout.write(`Installed ${installed.lockEntry.specifier} as ${reference.alias}\n`)
  }

  if (references.length === 0) {
    io.stdout.write('No static plugins found.\n')
  }

  return 0
}
