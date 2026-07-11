import type { ParsedPluginSpecifier } from './types'

const exactSemverPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-z-][0-9a-z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-z-][0-9a-z-]*))*)?(?:\+[0-9a-z-]+(?:\.[0-9a-z-]+)*)?$/i

export function formatPluginSpecifier(specifier: ParsedPluginSpecifier): string {
  return `${specifier.name}@${specifier.version}`
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

  return { name, raw, version }
}
