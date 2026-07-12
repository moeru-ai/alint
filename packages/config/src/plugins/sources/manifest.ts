import type { PackageJson } from '@package-json/types'

import { readFile } from 'node:fs/promises'

import { isPlainObject } from 'es-toolkit/compat'
import { exports as resolvePackageExports } from 'resolve.exports'

export async function readManifest(path: string): Promise<PackageJson> {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'))

  if (!isPlainObject(value)) {
    throw new Error('package manifest must be an object')
  }

  return value as PackageJson
}

export function resolveRelativeRootEntry(packageJson: PackageJson): string {
  // Select the Node ESM import condition; browser and CommonJS entries are not executable in this runtime.
  const [entry] = resolvePackageExports(packageJson, '.', { browser: false, require: false }) ?? []

  if (entry === undefined) {
    const name = typeof packageJson.name === 'string' ? packageJson.name : '<unknown>'
    throw new Error(`Package "${name}" does not define a resolvable "." export.`)
  }

  return entry.startsWith('./') ? entry.slice(2) : entry
}
