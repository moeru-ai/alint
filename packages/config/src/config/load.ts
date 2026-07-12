import type { AlintConfig } from '@alint-js/core'

import type { ParsedPluginLockEntry } from '../plugins/types'
import type { ParsedStaticConfig, StaticPluginReference } from './static'

import { resolve } from 'node:path'

import { loadConfig } from 'c12'
import { createJiti } from 'jiti/static'

import { listMissing, listUnresolved, loadPluginLockFile, parsePluginLockFile } from '../plugins/lock'
import { importResolvedPluginPackage, resolveLockedPluginPackage } from '../plugins/package'
import {
  formatPluginSpecifier,
  listStaticPluginReferences,
  parseStaticConfig,
  toAlintConfig,
} from './static'

interface C12LoadConfigResult {
  _configFile?: string
}

export async function loadAlintConfig(
  cwd: string,
  configFile?: string,
): Promise<AlintConfig> {
  const staticConfig = await loadStaticConfig(cwd, configFile)
  const references = listStaticPluginReferences(staticConfig)

  if (references.length === 0) {
    return toAlintConfig(staticConfig, {
      pluginResolver: async (reference) => {
        throw new Error(`Static plugin "${reference.alias}" was not expected to require resolution.`)
      },
    })
  }

  const lock = parsePluginLockFile(await loadPluginLockFile(cwd), { cwd })
  const missing = listMissing(staticConfig, lock)

  if (missing.length > 0) {
    throw new Error(`Static plugin references are missing from the lock file: ${formatStaticPluginReferences(missing)}.\nRun: alint plugin install`)
  }

  const unresolved = await listUnresolved(staticConfig, lock)

  if (unresolved.length > 0) {
    throw new Error(`Static plugin packages could not be resolved from the lock file: ${formatPluginLockEntries(unresolved)}.\nRun: alint plugin install`)
  }

  return toAlintConfig(staticConfig, {
    async pluginResolver(reference) {
      const resolved = await resolveLockedPluginPackage(lock.get(reference))
      return importResolvedPluginPackage(resolved)
    },
  })
}

export async function loadStaticConfig(
  cwd: string,
  configFile?: string,
): Promise<ParsedStaticConfig> {
  const result = await loadConfig({
    configFile,
    cwd,
    dotenv: true,
    // NOTICE: c12's default `jiti` import lazy-loads `../dist/babel.cjs`,
    // which Bun standalone executables do not discover while compiling. The
    // `jiti/static` entrypoint exists for this exact packaging shape and keeps
    // Babel's transform bundle in the static module graph.
    //
    // Source: `https://github.com/unjs/jiti/blob/fd3bb289b75ed207edfb686d671ed50144f7e90f/lib/jiti-static.mjs#L3-L4`
    jiti: createJiti(resolve(cwd, configFile ?? 'alint.config'), {
      interopDefault: true,
      moduleCache: false,
    }),
    name: 'alint',
  })

  // NOTICE: c12 returns `{}` for a missing config even without defaults. The
  // resolved config-file marker is the only result field that distinguishes
  // "not found" from an intentionally exported empty object.
  if ((result as C12LoadConfigResult)._configFile === undefined) {
    return parseStaticConfig(undefined)
  }

  return parseStaticConfig(result.config, {
    configFile: (result as C12LoadConfigResult)._configFile,
  })
}

function formatPluginLockEntries(entries: readonly ParsedPluginLockEntry[]): string {
  return entries
    .map(entry => `${entry.alias} (${formatPluginSpecifier(entry.specifier)})`)
    .join(', ')
}

function formatStaticPluginReferences(references: readonly StaticPluginReference[]): string {
  return references
    .map(reference => `${reference.alias} (${formatPluginSpecifier(reference.specifier)})`)
    .join(', ')
}
