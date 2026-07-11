export interface FetchNpmPackageVersionOptions {
  name: string
  registry: string
  version: string
}

export interface NpmPackageVersionMetadata {
  integrity: string
  name: string
  tarball: string
  version: string
}

interface NpmMetadataResponse {
  versions?: Record<string, {
    dist?: {
      integrity?: unknown
      tarball?: unknown
    }
  }>
}

export async function fetchNpmPackageVersion(
  options: FetchNpmPackageVersionOptions,
): Promise<NpmPackageVersionMetadata> {
  const response = await fetch(new URL(encodePackageName(options.name), normalizeRegistryUrl(options.registry)))

  if (!response.ok) {
    throw new Error(`Failed to fetch npm metadata for ${options.name}: HTTP ${response.status}.`)
  }

  const metadata = await response.json() as NpmMetadataResponse
  const version = metadata.versions?.[options.version]

  if (version === undefined) {
    throw new Error(`Package ${options.name} does not have version ${options.version}.`)
  }

  if (typeof version.dist?.tarball !== 'string' || typeof version.dist.integrity !== 'string') {
    throw new TypeError(`Package ${options.name}@${options.version} is missing tarball integrity metadata.`)
  }

  return {
    integrity: version.dist.integrity,
    name: options.name,
    tarball: version.dist.tarball,
    version: options.version,
  }
}

function encodePackageName(name: string): string {
  const parts = name.split('/')

  if (name.startsWith('@')) {
    if (parts.length !== 2 || !isValidPackageNameSegment(parts[0]!) || !isValidPackageNameSegment(parts[1]!)) {
      throw new Error(`Invalid npm package name "${name}".`)
    }

    return `@${encodeURIComponent(parts[0]!.slice(1))}%2f${encodeURIComponent(parts[1]!)}`
  }

  if (parts.length !== 1 || !isValidPackageNameSegment(parts[0]!)) {
    throw new Error(`Invalid npm package name "${name}".`)
  }

  return encodeURIComponent(parts[0]!)
}

function isValidPackageNameSegment(segment: string): boolean {
  return segment !== ''
    && segment !== '.'
    && segment !== '..'
    && !segment.includes('\\')
    && /^@?[\w.~-]+$/.test(segment)
}

function normalizeRegistryUrl(registry: string): string {
  return registry.endsWith('/') ? registry : `${registry}/`
}
