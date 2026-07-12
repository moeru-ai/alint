import type { ParsedPluginSpecifier } from './types'

import { formatPluginSpecifier } from './spec'

export interface FetchNpmPackageVersionOptions {
  registry: string
  specifier: ParsedPluginSpecifier
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
  const response = await fetch(new URL(options.specifier.packageName.registryPath, normalizeRegistryUrl(options.registry)))

  if (!response.ok) {
    throw new Error(`Failed to fetch npm metadata for ${options.specifier.name}: HTTP ${response.status}.`)
  }

  const metadata = await response.json() as NpmMetadataResponse
  const version = metadata.versions?.[options.specifier.version]

  if (version === undefined) {
    throw new Error(`Package ${options.specifier.name} does not have version ${options.specifier.version}.`)
  }

  if (typeof version.dist?.tarball !== 'string' || typeof version.dist.integrity !== 'string') {
    throw new TypeError(`Package ${formatPluginSpecifier(options.specifier)} is missing tarball integrity metadata.`)
  }

  return {
    integrity: version.dist.integrity,
    name: options.specifier.name,
    tarball: version.dist.tarball,
    version: options.specifier.version,
  }
}

function normalizeRegistryUrl(registry: string): string {
  return registry.endsWith('/') ? registry : `${registry}/`
}
