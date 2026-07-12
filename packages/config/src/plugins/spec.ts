import type { ParsedPluginPackageName, ParsedPluginSpecifier } from './types'

const exactSemverPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-z-][0-9a-z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-z-][0-9a-z-]*))*)?(?:\+[0-9a-z-]+(?:\.[0-9a-z-]+)*)?$/i

export function formatPluginSpecifier(specifier: ParsedPluginSpecifier): string {
  return `${specifier.name}@${specifier.version}`
}

export function parsePluginPackageName(name: string): ParsedPluginPackageName {
  const parts = name.split('/')

  if (name.startsWith('@')) {
    if (parts.length !== 2 || !isValidPackageNameSegment(parts[0]!) || !isValidPackageNameSegment(parts[1]!)) {
      throw new Error(`Invalid npm package name "${name}".`)
    }

    const scope = parts[0]!.slice(1)
    const unscopedName = parts[1]!

    return {
      name,
      registryPath: `@${encodeURIComponent(scope)}%2f${encodeURIComponent(unscopedName)}`,
      scope,
      unscopedName,
    }
  }

  if (parts.length !== 1 || !isValidPackageNameSegment(parts[0]!)) {
    throw new Error(`Invalid npm package name "${name}".`)
  }

  const unscopedName = parts[0]!

  return {
    name,
    registryPath: encodeURIComponent(unscopedName),
    unscopedName,
  }
}

export function parsePluginSpecifier(raw: string): ParsedPluginSpecifier {
  const separatorIndex = raw.lastIndexOf('@')

  if (separatorIndex <= 0) {
    throw new Error(`Static plugin specifier "${raw}" must include an exact version.`)
  }

  const name = raw.slice(0, separatorIndex)
  const version = raw.slice(separatorIndex + 1)

  if (!name || !version) {
    throw new Error(`Static plugin specifier "${raw}" must include an exact version.`)
  }

  if (!exactSemverPattern.test(version)) {
    throw new Error(`Static plugin specifier "${raw}" must use an exact version.`)
  }

  const packageName = parsePluginPackageName(name)

  return {
    name: packageName.name,
    packageName,
    raw,
    version,
  }
}

export function pluginPackagePathSegments(packageName: ParsedPluginPackageName): string[] {
  return packageName.scope === undefined
    ? [packageName.unscopedName]
    : [`@${packageName.scope}`, packageName.unscopedName]
}

function isValidPackageNameSegment(segment: string): boolean {
  return segment !== ''
    && segment !== '.'
    && segment !== '..'
    && !segment.includes('\\')
    && /^@?[\w.~-]+$/.test(segment)
}
