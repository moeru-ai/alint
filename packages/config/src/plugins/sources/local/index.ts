import type { DirectoryPluginSpecifier } from '../../spec'
import type { DirectoryPluginLockEntry, ParsedDirectoryPluginLockEntry } from '../../types'
import type { PluginImportTarget } from '../types'

import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve as resolvePath, win32 } from 'node:path'

import { errorMessageFrom } from '@moeru/std/error'

import { isENOENTError, isPathInside } from '../../../utils/fs'
import { readManifest, resolveRelativeRootEntry } from '../manifest'

export interface InstalledLocalSource {
  path: string
  type: 'directory'
}

export interface InstallOptions {
  alias: string
  specifier: DirectoryPluginSpecifier
}

export interface LockEntryOptions extends InstallOptions {
  cwd: string
}

export async function createLockEntry(
  installed: InstalledLocalSource,
  options: LockEntryOptions,
): Promise<DirectoryPluginLockEntry> {
  const relativePath = relative(await realpath(options.cwd), installed.path)
  const path = isAbsolute(relativePath) || win32.isAbsolute(relativePath)
    ? installed.path
    : relativePath === '' ? '.' : relativePath

  return {
    alias: options.alias,
    path,
    specifier: options.specifier.raw,
    type: 'directory',
  }
}

export async function install(options: InstallOptions): Promise<InstalledLocalSource> {
  const packageDir = await canonicalRoot(options.alias, options.specifier.directory)
  await validateRoot(options.alias, packageDir)

  return {
    path: packageDir,
    type: 'directory',
  }
}

export async function resolve(entry: ParsedDirectoryPluginLockEntry): Promise<PluginImportTarget> {
  const lockedPath = isAbsolute(entry.lockEntry.path) || win32.isAbsolute(entry.lockEntry.path)
    ? entry.lockEntry.path
    : resolvePath(entry.cwd, entry.lockEntry.path)
  const [packageDir, lockedPackageDir] = await Promise.all([
    lockedRoot(entry.alias, entry.specifier.directory, 'configured'),
    lockedRoot(entry.alias, lockedPath, 'locked'),
  ])

  if (packageDir !== lockedPackageDir) {
    throw new Error(`Directory plugin "${entry.alias}" has moved or its symlink target changed. Run: alint plugin install`)
  }

  return { cache: 'content', entry: await validateRoot(entry.alias, packageDir) }
}

async function canonicalRoot(alias: string, directory: string): Promise<string> {
  let packageDir

  try {
    packageDir = await realpath(directory)
  }
  catch (error) {
    if (isENOENTError(error)) {
      throw new Error(`Directory plugin "${alias}" does not exist at "${directory}".`, { cause: error })
    }

    throw new Error(`Could not inspect directory plugin "${alias}" at "${directory}": ${errorMessageFrom(error) ?? 'unknown error'}`, { cause: error })
  }

  let directoryStat

  try {
    directoryStat = await stat(packageDir)
  }
  catch (error) {
    throw new Error(`Could not inspect directory plugin "${alias}" at "${directory}": ${errorMessageFrom(error) ?? 'unknown error'}`, { cause: error })
  }

  if (!directoryStat.isDirectory()) {
    throw new Error(`Directory plugin "${alias}" path "${directory}" is not a directory.`)
  }

  return packageDir
}

async function lockedRoot(
  alias: string,
  directory: string,
  source: 'configured' | 'locked',
): Promise<string> {
  try {
    return await realpath(directory)
  }
  catch (error) {
    if (isENOENTError(error)) {
      throw new Error(`Directory plugin "${alias}" has moved or its symlink target changed. Run: alint plugin install`, { cause: error })
    }

    throw new Error(`Could not resolve ${source} directory plugin "${alias}" at "${directory}": ${errorMessageFrom(error) ?? 'unknown error'}`, { cause: error })
  }
}

async function validateRoot(alias: string, packageDir: string): Promise<string> {
  const manifestPath = join(packageDir, 'package.json')
  const packageJson = await readManifest(manifestPath).catch((error: unknown) => {
    throw new Error(`Directory plugin "${alias}" has an unreadable or invalid package.json at "${manifestPath}": ${errorMessageFrom(error) ?? 'unknown error'}`, { cause: error })
  })

  const relativeEntry = resolveRelativeRootEntry(packageJson)
  const entry = resolvePath(packageDir, relativeEntry)

  if (!isPathInside(entry, packageDir)) {
    throw new Error(`Directory plugin "${alias}" root export escapes the package directory.`)
  }

  let physicalEntry

  try {
    physicalEntry = await realpath(entry)
  }
  catch (error) {
    if (isENOENTError(error)) {
      throw new Error(`Directory plugin "${alias}" entry "${relativeEntry}" does not exist. Build the package and try again.`, { cause: error })
    }

    throw new Error(`Could not resolve directory plugin "${alias}" entry "${relativeEntry}": ${errorMessageFrom(error) ?? 'unknown error'}`, { cause: error })
  }

  if (!isPathInside(physicalEntry, packageDir)) {
    throw new Error(`Directory plugin "${alias}" entry physically escapes the package directory.`)
  }

  let entryStat

  try {
    entryStat = await stat(physicalEntry)
  }
  catch (error) {
    if (isENOENTError(error)) {
      throw new Error(`Directory plugin "${alias}" entry "${relativeEntry}" does not exist. Build the package and try again.`, { cause: error })
    }

    throw new Error(`Could not inspect directory plugin "${alias}" entry "${relativeEntry}": ${errorMessageFrom(error) ?? 'unknown error'}`, { cause: error })
  }

  if (!entryStat.isFile()) {
    throw new Error(`Directory plugin "${alias}" entry "${relativeEntry}" is not a regular file.`)
  }

  return physicalEntry
}
