import type { PluginImportTarget } from './sources/types'
import type { ParsedPluginLockEntry } from './types'

import * as localSource from './sources/local'
import * as packageSource from './sources/package'

export function resolvePluginImportTarget(entry: ParsedPluginLockEntry): Promise<PluginImportTarget> {
  return entry.type === 'directory' ? localSource.resolve(entry) : packageSource.resolve(entry)
}
