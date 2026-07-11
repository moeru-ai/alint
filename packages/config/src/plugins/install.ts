import type { ParsedPluginSpecifier, PluginLockEntry } from './types'

import process from 'node:process'

import { Buffer } from 'node:buffer'
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'

import { dirname, join, relative, resolve } from 'pathe'
import { object, parse, string } from 'valibot'

import { loadPluginLockFile, writePluginLockFile } from './lock'
import { fetchNpmPackageVersion } from './npm'
import { getProjectPluginDir, getStoredPluginPackageDir } from './paths'
import { formatPluginSpecifier } from './spec'
import { extractNpmTarball, verifyIntegrity } from './tarball'
import { verifyExtractedPluginPackage } from './verify'

const STORE_MANIFEST_FILE = '.alint-plugin-store.json'

const StoreManifestSchema = object({
  integrity: string(),
  name: string(),
  version: string(),
})

export interface InstalledStaticPlugin {
  entry: string
  lockEntry: PluginLockEntry
}

export interface InstallStaticPluginOptions {
  alias: string
  installLockTimeoutMs?: number
  registry: string
  specifier: ParsedPluginSpecifier
  supportedApiVersion: string
}

interface InstallVerifiedPackageOptions {
  cwd: string
  integrity: string
  metadataTarball: string
  options: InstallStaticPluginOptions
  packageDir: string
  registry: string
  stagingDir: string
}

export async function installStaticPlugin(
  cwd: string,
  options: InstallStaticPluginOptions,
): Promise<InstalledStaticPlugin> {
  const registry = normalizeRegistryUrl(options.registry)
  const metadata = await fetchNpmPackageVersion({
    name: options.specifier.name,
    registry,
    version: options.specifier.version,
  })
  const response = await fetch(metadata.tarball)

  if (!response.ok) {
    throw new Error(`Failed to download ${formatPluginSpecifier(options.specifier)}: HTTP ${response.status}.`)
  }

  const body = Buffer.from(await response.arrayBuffer())
  verifyIntegrity(body, metadata.integrity)

  const packageDir = getStoredPluginPackageDir(cwd, options.specifier.name, options.specifier.version)
  const stagingDir = uniqueSiblingDir(packageDir, 'staging')

  await rm(stagingDir, { force: true, recursive: true })

  try {
    await extractNpmTarball(body, stagingDir)
    await verifyExtractedPluginPackage(stagingDir, {
      expectedName: options.specifier.name,
      expectedVersion: options.specifier.version,
      supportedApiVersion: options.supportedApiVersion,
    })
    await writeStoreManifest(stagingDir, {
      integrity: metadata.integrity,
      name: options.specifier.name,
      version: options.specifier.version,
    })

    const lockEntry = await withPluginInstallLock(cwd, async () => installVerifiedPackage({
      cwd,
      integrity: metadata.integrity,
      metadataTarball: metadata.tarball,
      options,
      packageDir,
      registry,
      stagingDir,
    }), options.installLockTimeoutMs)

    return {
      entry: resolve(cwd, lockEntry.entry),
      lockEntry,
    }
  }
  catch (error) {
    await rm(stagingDir, { force: true, recursive: true })
    throw error
  }
}

async function installVerifiedPackage(input: InstallVerifiedPackageOptions): Promise<PluginLockEntry> {
  const lock = await loadPluginLockFile(input.cwd)
  const conflictingEntry = Object.values(lock.plugins).find(entry =>
    entry.name === input.options.specifier.name
    && entry.version === input.options.specifier.version
    && entry.integrity !== input.integrity,
  )

  if (conflictingEntry !== undefined) {
    throw new Error(`Plugin package ${formatPluginSpecifier(input.options.specifier)} is already installed with different integrity.`)
  }

  await mkdir(dirname(input.packageDir), { recursive: true })

  try {
    await stat(input.packageDir)
  }
  catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      throw error
    }

    await rename(input.stagingDir, input.packageDir)
    return await writeVerifiedPackageLockEntry(input, lock)
  }

  return await reuseInstalledPackage(input, lock)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function isPluginIntegrityConflict(error: unknown): error is Error {
  return error instanceof Error && error.message.includes('already installed with different integrity')
}

async function loadStoreManifest(packageDir: string): Promise<ReturnType<typeof parseStoreManifest>> {
  return parseStoreManifest(await readFile(join(packageDir, STORE_MANIFEST_FILE), 'utf8'))
}

function normalizeRegistryUrl(registry: string): string {
  return registry.endsWith('/') ? registry : `${registry}/`
}

function parseStoreManifest(content: string): {
  integrity: string
  name: string
  version: string
} {
  return parse(StoreManifestSchema, JSON.parse(content))
}

async function reuseInstalledPackage(
  input: InstallVerifiedPackageOptions,
  lock: Awaited<ReturnType<typeof loadPluginLockFile>>,
): Promise<PluginLockEntry> {
  try {
    return await writeVerifiedPackageLockEntry(input, lock)
  }
  catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw error
    }

    if (isPluginIntegrityConflict(error)) {
      throw error
    }

    throw new Error(`Existing plugin package ${formatPluginSpecifier(input.options.specifier)} is invalid. Remove ${input.packageDir} and run alint plugin install again.`, {
      cause: error,
    })
  }
  finally {
    await rm(input.stagingDir, { force: true, recursive: true })
  }
}

function storeRelativeEntry(
  cwd: string,
  packageDir: string,
  canonicalPackageDir: string,
  verifiedEntry: string,
): string {
  return relative(cwd, resolve(packageDir, relative(canonicalPackageDir, verifiedEntry)))
}

function uniqueSiblingDir(path: string, label: string): string {
  return `${path}.${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

async function verifyStoreManifest(input: InstallVerifiedPackageOptions): Promise<void> {
  const manifest = await loadStoreManifest(input.packageDir)

  if (
    manifest.name !== input.options.specifier.name
    || manifest.version !== input.options.specifier.version
  ) {
    throw new Error(`Existing plugin package store manifest does not match ${formatPluginSpecifier(input.options.specifier)}.`)
  }

  if (manifest.integrity !== input.integrity) {
    throw new Error(`Plugin package ${formatPluginSpecifier(input.options.specifier)} is already installed with different integrity.`)
  }
}

async function withPluginInstallLock<T>(
  cwd: string,
  operation: () => Promise<T>,
  timeoutMs = 30_000,
): Promise<T> {
  const lockDir = resolve(getProjectPluginDir(cwd), 'install.lock')
  const startedAt = Date.now()
  await mkdir(dirname(lockDir), { recursive: true })

  while (true) {
    try {
      await mkdir(lockDir)
      break
    }
    catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') {
        throw error
      }

      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for plugin install lock at ${lockDir}. Remove the lock directory if no alint plugin install process is running.`)
      }

      await sleep(25)
    }
  }

  try {
    return await operation()
  }
  finally {
    await rm(lockDir, { force: true, recursive: true })
  }
}

async function writeStoreManifest(
  packageDir: string,
  manifest: ReturnType<typeof parseStoreManifest>,
): Promise<void> {
  await writeFile(join(packageDir, STORE_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`)
}

async function writeVerifiedPackageLockEntry(
  input: InstallVerifiedPackageOptions,
  lock: Awaited<ReturnType<typeof loadPluginLockFile>>,
): Promise<PluginLockEntry> {
  await verifyStoreManifest(input)

  const verified = await verifyExtractedPluginPackage(input.packageDir, {
    expectedName: input.options.specifier.name,
    expectedVersion: input.options.specifier.version,
    supportedApiVersion: input.options.supportedApiVersion,
  })
  const canonicalPackageDir = await realpath(input.packageDir)
  const lockEntry: PluginLockEntry = {
    alias: input.options.alias,
    apiVersion: verified.apiVersion,
    entry: storeRelativeEntry(input.cwd, input.packageDir, canonicalPackageDir, verified.entry),
    integrity: input.integrity,
    name: input.options.specifier.name,
    registry: input.registry,
    specifier: formatPluginSpecifier(input.options.specifier),
    tarball: input.metadataTarball,
    version: input.options.specifier.version,
  }

  lock.plugins[input.options.alias] = lockEntry
  await writePluginLockFile(input.cwd, lock)

  return lockEntry
}
