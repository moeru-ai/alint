import type { PluginLockFile } from './types'

import process from 'node:process'

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'

import { dirname } from 'pathe'
import { literal, object, parse, record, string } from 'valibot'

import { isNodeError } from '../nodeError'
import { getProjectPluginLockPath } from './paths'

const PluginLockEntrySchema = object({
  alias: string(),
  entry: string(),
  integrity: string(),
  name: string(),
  registry: string(),
  specifier: string(),
  tarball: string(),
  version: string(),
})

const PluginLockFileSchema = object({
  plugins: record(string(), PluginLockEntrySchema),
  version: literal(1),
})

export function emptyPluginLockFile(): PluginLockFile {
  return {
    plugins: {},
    version: 1,
  }
}

export async function loadPluginLockFile(cwd: string): Promise<PluginLockFile> {
  const path = getProjectPluginLockPath(cwd)

  try {
    return parse(PluginLockFileSchema, JSON.parse(await readFile(path, 'utf8')))
  }
  catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return emptyPluginLockFile()
    }

    throw error
  }
}

export async function writePluginLockFile(
  cwd: string,
  lock: PluginLockFile,
): Promise<void> {
  const path = getProjectPluginLockPath(cwd)
  const tempPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  await mkdir(dirname(path), { recursive: true })

  try {
    await writeFile(tempPath, `${JSON.stringify(lock, null, 2)}\n`)
    await rename(tempPath, path)
  }
  catch (error) {
    await rm(tempPath, { force: true })
    throw error
  }
}
