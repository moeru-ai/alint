import type { Stats } from 'node:fs'

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { extractNpmTarball, parsePluginSpecifier, verifyExtractedPluginPackage } from '@alint-js/config'

import { defineCommand } from '../command'

const supportedApiVersion = '1'
const invalidPackageNames = new Set(['favicon.ico', 'node_modules'])
const globalOptionNames = new Set([
  'cache',
  'cacheLocation',
  'fileConcurrency',
  'format',
  'lang',
  'model',
  'progress',
  'ruleConcurrency',
  'stats',
  'timeoutMs',
])
const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u

interface PluginPackageIdentity {
  name: string
  version: string
}

export const verify = defineCommand({
  action: (context, path: string, options: { config?: string, registry?: string }) =>
    runPluginVerifyCommand(path, options, context.io),
  arguments: '<path>',
  description: 'Verify a static plugin package directory or npm tarball',
  name: 'verify',
  strictArguments: true,
})

async function extractPluginTarball(target: string, packageDir: string): Promise<void> {
  try {
    await extractNpmTarball(await readFile(target), packageDir)
  }
  catch (error) {
    throw new Error(`Failed to extract plugin tarball "${target}".`, {
      cause: error,
    })
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function isValidPackageName(name: string): boolean {
  return name.length <= 214
    && !invalidPackageNames.has(name)
    && packageNamePattern.test(name)
}

async function readPackageIdentity(packageDir: string): Promise<PluginPackageIdentity> {
  const value = await readPackageJson(packageDir)

  if (typeof value.name !== 'string' || value.name.trim().length === 0) {
    throw new Error(`Plugin package ${packageDir} must declare a non-empty package.json name.`)
  }

  if (typeof value.version !== 'string' || value.version.trim().length === 0) {
    throw new Error(`Plugin package ${packageDir} must declare a non-empty package.json version.`)
  }

  if (!isValidPackageName(value.name)) {
    throw new Error(`Plugin package ${packageDir} must declare a valid npm package name.`)
  }

  parsePluginSpecifier(`${value.name}@${value.version}`)

  return {
    name: value.name,
    version: value.version,
  }
}

async function readPackageJson(packageDir: string): Promise<{
  name?: unknown
  version?: unknown
}> {
  const packageJsonPath = join(packageDir, 'package.json')

  try {
    return JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
      name?: unknown
      version?: unknown
    }
  }
  catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new Error(`Plugin package ${packageDir} must include package.json.`, {
        cause: error,
      })
    }

    if (error instanceof SyntaxError) {
      throw new Error(`Plugin package ${packageDir} has invalid package.json.`, {
        cause: error,
      })
    }

    throw error
  }
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

function rejectUnsupportedVerifyOptions(options: { config?: string, registry?: string }): void {
  rejectUnsupportedOptions(options, new Set([...globalOptionNames, 'config', 'registry']))

  if (options.config !== undefined) {
    throw new Error('plugin verify does not support --config.')
  }

  if (options.registry !== undefined) {
    throw new Error('plugin verify does not support --registry.')
  }
}

async function runPluginVerifyCommand(
  inputPath: string,
  options: { config?: string, registry?: string },
  io: { cwd: string, stdout: { write: (chunk: string) => void } },
): Promise<number> {
  rejectUnsupportedVerifyOptions(options)

  const target = resolve(io.cwd, inputPath)
  const stats = await statPluginTarget(target, inputPath)
  let packageDir = target
  let cleanup: (() => Promise<void>) | undefined

  try {
    if (stats.isFile()) {
      const temp = await mkdtemp(join(tmpdir(), 'alint-plugin-verify-'))
      packageDir = join(temp, 'package')
      cleanup = () => rm(temp, { force: true, recursive: true })
      await extractPluginTarball(target, packageDir)
    }
    else if (!stats.isDirectory()) {
      throw new Error(`Plugin verify target "${inputPath}" must be a package directory or npm tarball.`)
    }

    const packageJson = await readPackageIdentity(packageDir)
    const verified = await verifyExtractedPluginPackage(packageDir, {
      expectedName: packageJson.name,
      expectedVersion: packageJson.version,
      supportedApiVersion,
    })

    io.stdout.write(`Verified ${verified.name}@${verified.version}\n`)
    return 0
  }
  finally {
    await cleanup?.()
  }
}

async function statPluginTarget(target: string, inputPath: string): Promise<Stats> {
  try {
    return await stat(target)
  }
  catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new Error(`Plugin verify target "${inputPath}" does not exist.`, {
        cause: error,
      })
    }

    throw error
  }
}
