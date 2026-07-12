import type { ParsedPluginSpecifier } from './types'

import { join } from 'pathe'

import { pluginPackagePathSegments } from './spec'

export function getProjectPluginDir(cwd: string): string {
  return join(cwd, '.alint', 'plugins')
}

export function getProjectPluginLockPath(cwd: string): string {
  return join(getProjectPluginDir(cwd), 'lock.json')
}

export function getProjectPluginStoreDir(cwd: string): string {
  return join(getProjectPluginDir(cwd), 'store')
}

export function getStoredPluginPackageDir(
  cwd: string,
  specifier: ParsedPluginSpecifier,
): string {
  return join(
    getProjectPluginStoreDir(cwd),
    ...pluginPackagePathSegments(specifier.packageName),
    validateVersionSegment(specifier.version),
    'package',
  )
}

function validateVersionSegment(version: string): string {
  if (
    version === ''
    || version === '.'
    || version === '..'
    || version.includes('/')
    || version.includes('\\')
  ) {
    throw new Error(`Invalid plugin package version "${version}".`)
  }

  return version
}
