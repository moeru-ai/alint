import { join } from 'pathe'

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
  name: string,
  version: string,
): string {
  return join(getProjectPluginStoreDir(cwd), ...splitPackageName(name), validateVersionSegment(version), 'package')
}

function splitPackageName(name: string): string[] {
  const parts = name.split('/')

  if (
    (parts.length !== 1 && parts.length !== 2)
    || parts.some(part => part === '' || part === '.' || part === '..' || part.includes('\\'))
    || (parts.length === 2 && !parts[0]!.startsWith('@'))
  ) {
    throw new Error(`Invalid plugin package name "${name}".`)
  }

  return parts
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
