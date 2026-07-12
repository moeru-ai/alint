import { isAbsolute, posix } from 'node:path'

export interface ParsedPluginSpecifier {
  name: string
  raw: string
  registryPath: string
  segments: string[]
  version: string
}

export function parsePluginSpecifier(value: string): ParsedPluginSpecifier {
  const versionSeparator = value.lastIndexOf('@')

  if (versionSeparator <= 0 || versionSeparator === value.length - 1) {
    throw new Error(`Static plugin specifier "${value}" must include an exact package version.`)
  }

  const name = value.slice(0, versionSeparator)
  const segments = parsePackageNameSegments(name)

  return {
    name,
    raw: value,
    registryPath: name.startsWith('@')
      ? name.replace('/', '%2f')
      : encodeURIComponent(name),
    segments,
    version: value.slice(versionSeparator + 1),
  }
}

function parsePackageNameSegments(name: string): string[] {
  if (
    name === ''
    || name.includes('\\')
    || isAbsolute(name)
    || posix.isAbsolute(name)
  ) {
    throw new Error(`Invalid static plugin package name "${name}".`)
  }

  const segments = name.split('/')

  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`Invalid static plugin package name "${name}".`)
  }

  const segmentPattern = /^[a-z0-9][a-z0-9._~-]*$/u

  if (name.startsWith('@')) {
    const [scope, packageName, extraSegment] = segments

    if (
      segments.length !== 2
      || scope === undefined
      || packageName === undefined
      || extraSegment !== undefined
      || !scope.startsWith('@')
      || !segmentPattern.test(scope.slice(1))
      || !segmentPattern.test(packageName)
    ) {
      throw new Error(`Invalid static plugin package name "${name}".`)
    }

    return segments
  }

  if (segments.length !== 1 || !segmentPattern.test(segments[0]!)) {
    throw new Error(`Invalid static plugin package name "${name}".`)
  }

  return segments
}
